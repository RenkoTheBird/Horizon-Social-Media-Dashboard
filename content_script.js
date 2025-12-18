// content_script.js
// Lightweight engagement tracker + content-type heuristics.
// Sends occasional aggregated engagement messages to background.
// Rate-limited to avoid too many messages.

(function () {
  // CAUSE C: Ignore iframes - only run in main frame
  if (window.top !== window.self) {
    console.log('[Horizon] Running in iframe, skipping execution');
    return;
  }
  
  // Diagnostic: Log that content script is running
  console.log('[Horizon] Content script loaded on:', location.hostname, location.pathname);
  
  const SEND_INTERVAL_MS = 5000; // how often to send accumulated engagement (every 5s)
  let active = document.visibilityState === 'visible' && document.hasFocus();
  let lastChange = Date.now();
  let accumulatedMs = 0;
  let lastSend = Date.now();
  let contextInvalidated = false; // Flag to stop all messaging attempts
  let currentPostTitle = ''; // Track current post title to detect changes
  let lastPostTitle = ''; // Track last sent post title
  let lastUrl = location.href; // Track URL to detect navigation
  let titleExtractionObserver = null; // MutationObserver for title extraction
  let titleMutationObserver = null; // MutationObserver to wait for title to appear (CAUSE A)
  let settings = {
    enableTracking: false,
    includeTitles: false
  };

  function loadSettings() {
    try {
      chrome.storage.local.get(['settings'], (res) => {
        const stored = res?.settings || {};
        settings = {
          enableTracking: stored.enableTracking === true,
          includeTitles: stored.includeTitles === true
        };
        
        // Set up title observer for Reddit after settings are loaded
        if (location.hostname.includes('reddit.com') && settings.includeTitles) {
          console.log('[Horizon] Reddit detected, setting up title observers...');
          // Use a small delay to ensure DOM is ready
          setTimeout(() => {
            setupTitleObserver();
            setupTitleMutationObserver(); // CAUSE A: Wait for title to appear
            // Also do an initial title extraction (URL-based, always available)
            const urlTitle = extractPostTitleFromUrl();
            console.log('[Horizon] Initial URL title extraction:', urlTitle ? urlTitle.substring(0, 50) : 'empty');
            if (urlTitle && urlTitle.length > 5 && !isGenericRedditTitle(urlTitle)) {
              currentPostTitle = urlTitle;
              lastUrl = location.href;
              console.log('[Horizon] Initial post title extracted from URL:', urlTitle.substring(0, 50));
            } else {
              console.log('[Horizon] Initial URL title extraction failed or invalid:', {
                urlTitle: urlTitle,
                length: urlTitle?.length || 0,
                isGeneric: urlTitle ? isGenericRedditTitle(urlTitle) : 'N/A',
                pathname: location.pathname
              });
            }
          }, 1000);
        } else {
          console.log('[Horizon] Title observers not set up:', {
            isReddit: location.hostname.includes('reddit.com'),
            includeTitles: settings.includeTitles
          });
        }
      });
    } catch (err) {
      console.error('[Horizon] Failed to load settings:', err);
    }
  }

  // React to option updates without page reload
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const newSettings = changes.settings.newValue || {};
    settings = {
      enableTracking: newSettings.enableTracking === true,
      includeTitles: newSettings.includeTitles === true
    };
    if (!settings.includeTitles) {
      currentPostTitle = '';
      lastPostTitle = '';
      // Clean up observer if titles are disabled
      if (titleExtractionObserver) {
        titleExtractionObserver.disconnect();
        titleExtractionObserver = null;
      }
    } else if (location.hostname.includes('reddit.com')) {
      // Set up observer if titles are enabled
      setupTitleObserver();
      setupTitleMutationObserver(); // CAUSE A: Wait for title to appear
    }
  });

  loadSettings();

  // simple content type detection (heuristic)
  function detectContentType() {
    try {
      if (document.querySelector('video')) return 'video';
      const imgs = document.querySelectorAll('img').length;
      if (imgs > 10) return 'gallery';
      const bodyText = (document.body && document.body.innerText) || '';
      const trimmed = bodyText.trim();
      if (trimmed.length > 3000) return 'long_read';
      if (trimmed.length > 800) return 'article';
      return 'short_text';
    } catch (err) {
      return 'unknown';
    }
  }

  // Helper function to extract title from URL (always available, doesn't depend on DOM)
  // MUST be defined before extractPostTitle() which calls it
  function extractPostTitleFromUrl() {
    if (!location.hostname.includes('reddit.com')) {
      return '';
    }
    
    const pathname = location.pathname; // Don't lowercase - preserve original
    const isIndividualPost = pathname.includes('/r/') && pathname.includes('/comments/');
    
    if (!isIndividualPost) {
      return '';
    }
    
    // Skip comment permalinks
    const pathParts = pathname.split('/').filter(part => part.length > 0);
    const hasCommentId = pathParts.length > 5 && pathParts[5] && pathParts[5].length > 10;
    if (hasCommentId) {
      return '';
    }
    
    const urlParts = pathname.split('/').filter(part => part.length > 0);
    const commentsIndex = urlParts.findIndex(part => part.toLowerCase() === 'comments');
    
    if (commentsIndex !== -1 && urlParts.length > commentsIndex + 2) {
      const postTitleFromUrl = urlParts[commentsIndex + 2];
      const looksLikePostId = postTitleFromUrl.length < 8 && /^[a-z0-9]+$/i.test(postTitleFromUrl);
      
      if (postTitleFromUrl && postTitleFromUrl.length > 5 && !looksLikePostId) {
        try {
          const decodedTitle = decodeURIComponent(postTitleFromUrl);
          const cleanedTitle = decodedTitle.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleanedTitle && cleanedTitle.length > 5 && !isGenericRedditTitle(cleanedTitle)) {
            return cleanedTitle.substring(0, 200);
          }
        } catch (decodeError) {
          const cleanedTitle = postTitleFromUrl.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
          if (cleanedTitle && cleanedTitle.length > 5 && !isGenericRedditTitle(cleanedTitle)) {
            return cleanedTitle.substring(0, 200);
          }
        }
      } else if (postTitleFromUrl && looksLikePostId && urlParts.length > commentsIndex + 3) {
        // If we got a post ID, try the next segment
        const nextSegment = urlParts[commentsIndex + 3];
        if (nextSegment && nextSegment.length > 5) {
          try {
            const decodedTitle = decodeURIComponent(nextSegment);
            const cleanedTitle = decodedTitle.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
            if (cleanedTitle && cleanedTitle.length > 5 && !isGenericRedditTitle(cleanedTitle)) {
              return cleanedTitle.substring(0, 200);
            }
          } catch (e) {
            const cleanedTitle = nextSegment.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
            if (cleanedTitle && cleanedTitle.length > 5 && !isGenericRedditTitle(cleanedTitle)) {
              return cleanedTitle.substring(0, 200);
            }
          }
        }
      }
    }
    
    return '';
  }

  // Extract post title/metadata from social media platforms (TOS-compliant: only titles and metadata)
  // Helper function to detect generic Reddit titles
  function isGenericRedditTitle(title) {
    if (!title || typeof title !== 'string') return true;
    const lower = title.toLowerCase().trim();
    // List of generic Reddit titles/taglines to filter out
    const genericTitles = [
      'reddit',
      'reddit - the heart of the internet',
      'reddit: the heart of the internet',
      'the heart of the internet',
      'reddit - dive into anything',
      'reddit: dive into anything',
      'dive into anything',
      'home',
      'popular',
      'all',
      'reddit.com',
      'www.reddit.com'
    ];
    
    // Check for exact matches
    if (genericTitles.includes(lower)) return true;
    
    // Check if it starts with generic patterns
    if (lower.match(/^(reddit|home|popular|all|r\/)/i)) return true;
    
    // Check if it's just "Reddit" or variations
    if (lower === 'reddit' || lower.startsWith('reddit -') || lower.startsWith('reddit:')) {
      // But allow if there's more meaningful content after
      const afterReddit = lower.replace(/^reddit\s*[-:]\s*/i, '').trim();
      if (afterReddit.length < 10) return true; // Too short, probably generic
    }
    
    return false;
  }

  function extractPostTitle() {
    try {
      const hostname = location.hostname.toLowerCase();
      const pathname = location.pathname.toLowerCase();
      
      // Twitter/X: Extract from meta tags or article elements
      if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
        // Skip homepage - don't classify the homepage feed
        if (pathname === '/home' || pathname === '/') {
          return '';
        }
        
        // Check if we're on an individual post page (has /status/ in URL)
        const isIndividualPost = pathname.includes('/status/');
        
        // Only extract title for individual posts, not on homepage/feed
        if (!isIndividualPost) {
          return '';
        }
        
        // Try meta tags first (most reliable, TOS-compliant)
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle && ogTitle.content) {
          let title = ogTitle.content.trim();
          // Remove site name suffix if present
          title = title.replace(/\s*\/\s*X$|\s*on X$|\s*on Twitter$/i, '').trim();
          // Only use if it's meaningful (not just "Home / X")
          if (title && title.length > 5 && !title.match(/^(Home|Explore|Notifications|Messages|Profile)/i)) {
            return title;
          }
        }
        
        // Try Twitter card meta
        const twitterTitle = document.querySelector('meta[name="twitter:title"]');
        if (twitterTitle && twitterTitle.content) {
          const title = twitterTitle.content.trim();
          if (title && title.length > 5) {
            return title;
          }
        }
        
        // For individual post pages, try to get tweet text from article
        if (isIndividualPost) {
          const tweetArticle = document.querySelector('article[data-testid="tweet"]');
          if (tweetArticle) {
            // Extract text from tweet text span (first level text content)
            const tweetText = tweetArticle.querySelector('[data-testid="tweetText"]');
            if (tweetText) {
              const text = tweetText.textContent.trim().substring(0, 200);
              if (text && text.length > 5) {
                return text;
              }
            }
          }
        }
      }
      
      // Reddit: Extract from post-specific elements, NOT generic Reddit taglines
      if (hostname.includes('reddit.com')) {
        // Check if we're on an individual post page (has /r/ and /comments/ in URL)
        const isIndividualPost = pathname.includes('/r/') && pathname.includes('/comments/');
        
        // Skip if we're on a comment permalink (has /comments/ID/post_title/comment_id)
        // Only track the main post, not individual comments
        const pathParts = pathname.split('/');
        const hasCommentId = pathParts.length > 5 && pathParts[5] && pathParts[5].length > 10;
        if (hasCommentId) {
          // This is a comment permalink, not a post - skip
          return '';
        }
        
        // PRIORITY 0: Extract post title from URL (most reliable, always available)
        // Use helper function for consistency
        const urlTitle = extractPostTitleFromUrl();
        if (urlTitle && urlTitle.length > 5) {
          console.log('[Horizon] Extracted Reddit title from URL:', urlTitle.substring(0, 50));
          return urlTitle;
        }
        
        // PRIORITY 1: Check div with id "canonical_url_updater" (user-specified - most reliable)
        const canonicalUrlUpdater = document.getElementById('canonical_url_updater');
        if (canonicalUrlUpdater) {
          // This div contains the post title - look for it in various ways
          // First, try to find a heading or link within it
          const titleElement = canonicalUrlUpdater.querySelector('h1, h2, h3, h4, a[href*="/comments/"], [data-testid*="title"]') || canonicalUrlUpdater;
          let text = titleElement.textContent?.trim() || titleElement.innerText?.trim() || '';
          
          // If we got the whole div content, try to extract just the title part
          if (text && text.length > 100) {
            // Might have extra content, try to find the actual title
            const heading = canonicalUrlUpdater.querySelector('h1, h2, h3, h4');
            if (heading) {
              text = heading.textContent?.trim() || heading.innerText?.trim() || '';
            }
          }
          
          if (text && text.length > 5 && !isGenericRedditTitle(text)) {
            console.log('[Horizon] Extracted Reddit title from canonical_url_updater:', text.substring(0, 50));
            return text.substring(0, 200);
          }
        }
        
        // PRIORITY 2: Check reddit-page-data tag for post data
        const redditPageData = document.querySelector('reddit-page-data');
        if (redditPageData) {
          try {
            // The reddit-page-data tag might contain JSON data in a data attribute or as text
            // Try data attributes first
            const dataAttrs = ['data-title', 'data-post-title', 'title'];
            for (const attr of dataAttrs) {
              const attrValue = redditPageData.getAttribute(attr);
              if (attrValue && attrValue.trim().length > 5 && !isGenericRedditTitle(attrValue)) {
                console.log('[Horizon] Extracted Reddit title from reddit-page-data attribute', attr + ':', attrValue.substring(0, 50));
                return attrValue.trim().substring(0, 200);
              }
            }
            
            // Try parsing as JSON if it's in textContent
            const dataContent = redditPageData.textContent || redditPageData.innerText || '';
            if (dataContent) {
              try {
                const pageData = JSON.parse(dataContent);
                // Look for post title in various possible locations
                if (pageData.post?.title) {
                  const title = pageData.post.title.trim();
                  if (title && title.length > 5 && !isGenericRedditTitle(title)) {
                    console.log('[Horizon] Extracted Reddit title from reddit-page-data.post.title:', title.substring(0, 50));
                    return title.substring(0, 200);
                  }
                }
                if (pageData.title && !isGenericRedditTitle(pageData.title)) {
                  const title = pageData.title.trim();
                  if (title && title.length > 5) {
                    console.log('[Horizon] Extracted Reddit title from reddit-page-data.title:', title.substring(0, 50));
                    return title.substring(0, 200);
                  }
                }
                // Also check for nested structures
                if (pageData.data?.post?.title) {
                  const title = pageData.data.post.title.trim();
                  if (title && title.length > 5 && !isGenericRedditTitle(title)) {
                    console.log('[Horizon] Extracted Reddit title from reddit-page-data.data.post.title:', title.substring(0, 50));
                    return title.substring(0, 200);
                  }
                }
              } catch (parseError) {
                // Not JSON, try as text
                const title = dataContent.trim();
                if (title && title.length > 5 && !isGenericRedditTitle(title)) {
                  console.log('[Horizon] Extracted Reddit title from reddit-page-data (text):', title.substring(0, 50));
                  return title.substring(0, 200);
                }
              }
            }
          } catch (error) {
            console.log('[Horizon] Error reading reddit-page-data:', error);
          }
        }
        
        // PRIORITY 3: For individual posts, try to get post title from various Reddit UI selectors
        // CAUSE B: Reddit uses many different layouts - try all common selectors
        if (isIndividualPost) {
          // Try multiple selectors for Reddit post titles (new and old UI, all variants)
          const selectors = [
            // New Reddit - primary selectors
            'h1[data-testid="post-content"]',
            'h1[data-test-id="post-content"]', // Variant spelling
            'h2[data-testid="post-content"]',
            'h3[data-testid="post-content"]',
            'div[data-testid="post-title"] h1',
            'div[data-testid="post-title"] h2',
            'div[data-click-id="text"] h1',
            'a[data-testid="post-title"]',
            // Old Reddit
            'a.title',
            'a.title.may-blank',
            // Web components and slots
            '[slot="title"]',
            'shreddit-post h1',
            'shreddit-post h2',
            'shreddit-post h3',
            'shreddit-post [slot="title"]',
            'faceplate-tracker[source="post"] h1',
            'faceplate-tracker[source="post"] h2',
            'faceplate-tracker[source="post"] h3',
            // Generic title selectors
            'h1[class*="title"]',
            'h2[class*="title"]',
            'h3[class*="title"]',
            // Additional Reddit-specific selectors
            '[data-click-id="text"]',
            'article h1',
            'article h2',
            '[data-testid="post-container"] h1',
            '[data-testid="post-container"] h2'
          ];
          
          for (const selector of selectors) {
            const postTitle = document.querySelector(selector);
            if (postTitle) {
              const text = postTitle.textContent?.trim() || postTitle.innerText?.trim() || '';
              if (text && text.length > 5 && !isGenericRedditTitle(text)) {
                // Verify this is the main post title, not a comment
                const parent = postTitle.closest('article, [data-testid="post-container"], shreddit-post, faceplate-tracker[source="post"]');
                if (parent) {
                  console.log('[Horizon] Extracted Reddit title from selector', selector + ':', text.substring(0, 50));
                  return text.substring(0, 200);
                }
              }
            }
          }
          
          // Last resort: try to find any h1/h2/h3 that looks like a post title
          const headings = document.querySelectorAll('h1, h2, h3');
          for (const heading of headings) {
            const text = heading.textContent?.trim() || '';
            // Check if it's in a post container and not a comment
            const isInPost = heading.closest('article, [data-testid="post-container"], shreddit-post, faceplate-tracker[source="post"]');
            const isNotComment = !heading.closest('[data-testid*="comment"], [class*="comment"]');
            if (text && text.length > 5 && isInPost && isNotComment && !isGenericRedditTitle(text)) {
              console.log('[Horizon] Extracted Reddit title from heading:', text.substring(0, 50));
              return text.substring(0, 200);
            }
          }
        }
        
        // PRIORITY 4: Try meta tags, but filter out generic Reddit titles
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle && ogTitle.content) {
          const title = ogTitle.content.trim();
          // Remove "posted in r/..." or ": r/subreddit" suffix if present
          const cleaned = title.replace(/\s*:\s*r\/.*$/i, '').replace(/\s*posted in r\/.*$/i, '').trim();
          // Skip if it's a generic Reddit title
          if (cleaned && cleaned.length > 5 && !isGenericRedditTitle(cleaned)) {
            console.log('[Horizon] Extracted Reddit title from og:title:', cleaned.substring(0, 50));
            return cleaned;
          }
        }
        
        // PRIORITY 5: Try Reddit-specific meta
        const twitterTitle = document.querySelector('meta[name="twitter:title"]');
        if (twitterTitle && twitterTitle.content) {
          const title = twitterTitle.content.trim();
          const cleaned = title.replace(/\s*:\s*r\/.*$/i, '').trim();
          if (cleaned && cleaned.length > 5 && !isGenericRedditTitle(cleaned)) {
            console.log('[Horizon] Extracted Reddit title from twitter:title:', cleaned.substring(0, 50));
            return cleaned;
          }
        }
        
        // For Reddit feed pages, try to extract post titles from the feed
        // This helps when browsing the feed (not individual post pages)
        if (!isIndividualPost && pathname.match(/^\/r\/\w+|^\/$/)) {
          // On feed pages, we can't reliably get a single post title
          // But we can log that we're on a feed page
          console.log('[Horizon] On Reddit feed page, cannot extract single post title');
        }
      }
      
      // Instagram: Only classify posts in Explore section (URLs with /p/)
      // Extract post caption, not title/description
      if (hostname.includes('instagram.com')) {
        // Only process if we're on a post page (has /p/ in URL)
        const isPostPage = pathname.includes('/p/');
        if (!isPostPage) {
          // Not on a post page (e.g., homepage), skip classification
          return '';
        }
        
        // Extract post caption from DOM
        // Instagram captions are typically in article elements with specific structure
        // Try multiple selectors to find the caption
        const captionSelectors = [
          'article h1',
          'article span[dir="auto"]',
          'article div[dir="auto"]',
          'article [data-testid="post-caption"]',
          'article header + div span',
          'article header + div div',
          // More specific selectors for Instagram's structure
          'article > div > div > div span[dir="auto"]',
          'article > div > div > div div[dir="auto"]',
          // Look for spans/divs that contain the actual caption text
          'article span[style*="text-align"]',
          'article div[style*="text-align"]'
        ];
        
        for (const selector of captionSelectors) {
          const captionElement = document.querySelector(selector);
          if (captionElement) {
            const captionText = captionElement.textContent?.trim() || captionElement.innerText?.trim() || '';
            // Filter out very short text (likely not a caption) and generic Instagram text
            if (captionText && captionText.length > 10 && 
                !captionText.match(/^(Instagram|View|Follow|Like|Comment|Share|Save|More)$/i)) {
              // Check if this is actually a caption (not username, button text, etc.)
              // Captions are usually longer and don't start with @ or #
              const isLikelyCaption = captionText.length > 20 || 
                                      (!captionText.startsWith('@') && !captionText.startsWith('#'));
              if (isLikelyCaption) {
                console.log('[Horizon] Extracted Instagram caption:', captionText.substring(0, 50));
                return captionText.substring(0, 500); // Limit to 500 chars
              }
            }
          }
        }
        
        // Alternative: Try to find caption by looking for text that's not in header/nav
        // Instagram posts have captions in the main article content area
        const article = document.querySelector('article');
        if (article) {
          // Get all text nodes, but exclude header and navigation elements
          const header = article.querySelector('header');
          const headerText = header ? header.textContent : '';
          
          // Get article text and remove header text
          let articleText = article.textContent || article.innerText || '';
          if (headerText) {
            articleText = articleText.replace(headerText, '').trim();
          }
          
          // Remove common Instagram UI text
          articleText = articleText
            .replace(/View all \d+ comments?/gi, '')
            .replace(/Add a comment\.\.\./gi, '')
            .replace(/Like|Comment|Share|Save|More/gi, '')
            .replace(/Follow|Following|Message|Unfollow/gi, '')
            .trim();
          
          // If we have meaningful text (likely the caption), use it
          if (articleText && articleText.length > 10) {
            // Split by newlines and take the first substantial line (likely the caption)
            const lines = articleText.split('\n').filter(line => line.trim().length > 10);
            if (lines.length > 0) {
              const caption = lines[0].trim();
              // Make sure it's not just UI text
              if (!caption.match(/^(Instagram|View|Follow|Like|Comment|Share|Save|More|Add a comment)$/i)) {
                console.log('[Horizon] Extracted Instagram caption from article text:', caption.substring(0, 50));
                return caption.substring(0, 500);
              }
            }
          }
        }
        
        // No caption found - return empty string (don't classify)
        console.log('[Horizon] No Instagram caption found, skipping classification');
        return '';
      }
      
      // Fallback: For Reddit, NEVER use document.title or generic meta tags
      // These always contain "Reddit - The heart of the internet" or similar
      if (hostname.includes('reddit.com')) {
        // For Reddit, we've exhausted all post-specific extraction methods
        // Don't fall back to document.title or generic meta tags - they're always wrong
        console.log('[Horizon] Could not extract valid Reddit post title from DOM or URL, returning empty');
        return '';
      }
      
      // For non-Reddit sites, use standard fallbacks
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && ogTitle.content) {
        return ogTitle.content.trim();
      }
      
      const metaDescription = document.querySelector('meta[name="description"]');
      if (metaDescription && metaDescription.content) {
        return metaDescription.content.trim().substring(0, 200);
      }
      
      // Last resort: page title
      return document.title || '';
    } catch (err) {
      console.error('[Horizon] Error extracting post title:', err);
      // For Reddit, never return document.title (it's always generic)
      if (location.hostname.includes('reddit.com')) {
        return '';
      }
      // For other sites, document.title is acceptable as last resort
      return document.title || '';
    }
  }

  function sendEngagement(deltaMs) {
    if (!settings.enableTracking || deltaMs <= 0) {
      accumulatedMs = 0;
      return;
    }

    // If context is already invalidated, don't try to send
    if (contextInvalidated) {
      return;
    }
    
    // Safely check if extension runtime is still available
    let runtimeAvailable = false;
    try {
      runtimeAvailable = chrome && chrome.runtime && chrome.runtime.id;
    } catch (e) {
      // Accessing chrome.runtime itself can throw if context is invalidated
      contextInvalidated = true;
      return;
    }
    
    if (!runtimeAvailable) {
      contextInvalidated = true;
      return;
    }
    
    // Build payload safely (don't access chrome.runtime here)
    // Extract post title/metadata (TOS-compliant: only reads titles and metadata)
    const previousTitle = currentPostTitle;
    currentPostTitle = settings.includeTitles ? extractPostTitle() : '';
    
    // For Reddit, always try URL extraction as fallback if DOM extraction failed
    if (location.hostname.includes('reddit.com') && settings.includeTitles && (!currentPostTitle || currentPostTitle.length === 0)) {
      const urlTitle = extractPostTitleFromUrl();
      if (urlTitle && urlTitle.length > 5 && !isGenericRedditTitle(urlTitle)) {
        console.log('[Horizon] Using URL-extracted title (DOM extraction failed):', urlTitle.substring(0, 50));
        currentPostTitle = urlTitle;
      }
    }
    
    // Debug logging for title extraction - ALWAYS log for Reddit to diagnose issues
    if (location.hostname.includes('reddit.com')) {
      console.log('[Horizon] sendEngagement called:', {
        includeTitles: settings.includeTitles,
        extracted: currentPostTitle ? currentPostTitle.substring(0, 50) : 'empty',
        length: currentPostTitle?.length || 0,
        previousTitle: previousTitle ? previousTitle.substring(0, 50) : 'none',
        url: location.href.substring(0, 80),
        pathname: location.pathname
      });
    } else if (settings.includeTitles) {
      console.log('[Horizon] Title extraction result:', {
        extracted: currentPostTitle ? currentPostTitle.substring(0, 50) : 'empty',
        length: currentPostTitle?.length || 0,
        url: location.href.substring(0, 80)
      });
    }
    
    // Skip sending if we're on Twitter/X homepage
    const isTwitterHomepage = (location.hostname.includes('twitter.com') || location.hostname.includes('x.com')) &&
                              (location.pathname === '/home' || location.pathname === '/');
    if (isTwitterHomepage) {
      // Don't classify the homepage - only classify individual posts
      return;
    }
    
    // Skip sending if we're on Instagram homepage (not a post page with /p/ in URL)
    const isInstagramHomepage = location.hostname.includes('instagram.com') &&
                                 !location.pathname.includes('/p/');
    if (isInstagramHomepage) {
      // Don't classify the homepage - only classify posts in Explore section
      return;
    }
    
    // Only send if we have meaningful content (not just page title like "Home / X")
    const meaningfulTitle = settings.includeTitles &&
                           currentPostTitle &&
                           currentPostTitle.length > 5 &&
                           !currentPostTitle.match(/^(Home|Explore|Notifications|Messages|Profile|Reddit)/i);
    
    // Don't send if title hasn't changed (avoid duplicate tracking of same post)
    // But still send if it's been more than 30 seconds since last send (for long reads)
    const timeSinceLastSend = Date.now() - lastSend;
    const shouldSend = meaningfulTitle && 
                       (currentPostTitle !== lastPostTitle || timeSinceLastSend > 30000);
    
    const payload = {
      type: 'engagement_time',
      domain: location.hostname,
      deltaMs,
      contentType: detectContentType(),
      capturedAt: Date.now()
    };
    
    // Always include title if we have one and includeTitles is enabled
    // The background script will handle validation
    // For Reddit, also try URL extraction if DOM extraction failed
    if (settings.includeTitles) {
      if (currentPostTitle && currentPostTitle.length > 0) {
        payload.title = currentPostTitle;
      } else if (location.hostname.includes('reddit.com')) {
        // If DOM extraction failed, try URL extraction as fallback
        const urlTitle = extractPostTitleFromUrl();
        if (urlTitle && urlTitle.length > 5 && !isGenericRedditTitle(urlTitle)) {
          console.log('[Horizon] Using URL-extracted title as fallback in payload:', urlTitle.substring(0, 50));
          payload.title = urlTitle;
          currentPostTitle = urlTitle; // Update current title
        } else {
          console.log('[Horizon] No title found (DOM or URL extraction failed)');
        }
      }
    }
    
    if (meaningfulTitle && shouldSend) {
      // Log for debugging (only if meaningful title found and changed)
      if (currentPostTitle !== lastPostTitle) {
        console.log('[Horizon] Tracking new post:', currentPostTitle.substring(0, 50) + '...');
        lastPostTitle = currentPostTitle;
      }
    } else if (meaningfulTitle && !shouldSend) {
      // Same post, don't send title again to avoid duplicate counting
      // But still send engagement time
      console.log('[Horizon] Same post, skipping title to avoid duplicate count');
    } else if (settings.includeTitles && currentPostTitle && currentPostTitle.length > 0) {
      // Title exists but doesn't meet "meaningful" criteria - still send it
      console.log('[Horizon] Sending title that may not meet criteria:', currentPostTitle.substring(0, 50));
    }
    
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        // Handle extension context invalidation
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message || '';
          if (errorMsg.includes('Extension context invalidated') || 
              errorMsg.includes('message port closed') ||
              errorMsg.includes('Could not establish connection')) {
            // Extension was reloaded - stop trying to send messages
            contextInvalidated = true;
            console.log('[Horizon] Extension context invalidated. Please refresh the page to resume tracking.');
            return;
          }
          // Other errors (service worker may be asleep) - ignore
        }
        if (response?.success) {
          // Only log embedding hash if semantic embedding is enabled
          if (response.embeddingHash) {
            chrome.storage.local.get(['settings'], (res) => {
              const settings = res.settings || {};
              if (settings.useSemanticEmbedding === true) {
                console.log('[Horizon] Embedding cached with hash:', response.embeddingHash);
              }
            });
          }
          if (response.topic) {
            console.log('[Horizon] Post classified as:', response.topic);
          } else if (meaningfulTitle && payload.title) {
            console.log('[Horizon] Post classification returned no topic (check service worker console for details)');
          }
        }
      });
    } catch (error) {
      // Catch any runtime errors (e.g., extension context invalidated)
      const errorMsg = error.message || '';
      if (errorMsg.includes('Extension context invalidated') ||
          errorMsg.includes('message port closed') ||
          errorMsg.includes('Could not establish connection')) {
        contextInvalidated = true;
        console.log('[Horizon] Extension context invalidated. Please refresh the page to resume tracking.');
      }
      // Silently ignore other errors
    }
  }

  function updateState(isActive) {
    const now = Date.now();
    if (active) {
      accumulatedMs += now - lastChange;
    }
    active = isActive;
    lastChange = now;

    // keep periodic sends to avoid large in-memory accumulation
    if (Date.now() - lastSend > SEND_INTERVAL_MS && accumulatedMs > 0) {
      sendEngagement(accumulatedMs);
      accumulatedMs = 0;
      lastSend = Date.now();
    }
  }

  // event listeners to detect engagement
  document.addEventListener('visibilitychange', () => updateState(document.visibilityState === 'visible'));
  window.addEventListener('focus', () => updateState(true));
  window.addEventListener('blur', () => updateState(false));
  ['mousemove', 'keydown', 'scroll', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => {
      if (!active) updateState(true);
    }, { passive: true })
  );
  
  // Function to handle post navigation (when URL changes or post is clicked)
  function handlePostNavigation() {
    if (!settings.includeTitles || !location.hostname.includes('reddit.com')) {
      return;
    }
    
    const currentUrl = location.href;
    const isPostPage = currentUrl.includes('/r/') && currentUrl.includes('/comments/');
    
    // Only process if we're on a post page and URL changed
    if (isPostPage && currentUrl !== lastUrl) {
      console.log('[Horizon] URL changed, detecting new post. Old URL:', lastUrl.substring(0, 60), 'New URL:', currentUrl.substring(0, 60));
      lastUrl = currentUrl;
      
      // Try multiple times with increasing delays to catch async content loading
      const attempts = [500, 1000, 2000, 3000];
      let attemptIndex = 0;
      
      const tryExtractTitle = () => {
        const newTitle = extractPostTitle();
        console.log('[Horizon] Title extraction attempt', attemptIndex + 1, ':', newTitle ? newTitle.substring(0, 50) : 'empty');
        
        if (newTitle && newTitle.length > 5 && !isGenericRedditTitle(newTitle) && newTitle !== currentPostTitle) {
          console.log('[Horizon] New post detected! Title:', newTitle.substring(0, 50));
          currentPostTitle = newTitle;
          lastPostTitle = ''; // Reset to force sending the new title
          
          // Send engagement immediately for the new post
          if (accumulatedMs > 0) {
            sendEngagement(accumulatedMs);
            accumulatedMs = 0;
            lastSend = Date.now();
          }
        } else if (attemptIndex < attempts.length - 1) {
          // Try again with next delay
          attemptIndex++;
          setTimeout(tryExtractTitle, attempts[attemptIndex] - attempts[attemptIndex - 1]);
        } else {
          console.warn('[Horizon] Could not extract valid post title after all attempts');
        }
      };
      
      // Start trying after first delay
      setTimeout(tryExtractTitle, attempts[0]);
    }
  }
  
  // CAUSE A: Set up MutationObserver to wait for title to appear (DOM not loaded yet)
  function setupTitleMutationObserver() {
    if (!settings.includeTitles || !location.hostname.includes('reddit.com')) {
      console.log('[Horizon] setupTitleMutationObserver skipped:', {
        includeTitles: settings.includeTitles,
        isReddit: location.hostname.includes('reddit.com')
      });
      return;
    }
    
    // Clean up existing observer
    if (titleMutationObserver) {
      titleMutationObserver.disconnect();
      titleMutationObserver = null;
    }
    
    // Check if we're on a post page
    const isPostPage = location.pathname.includes('/r/') && location.pathname.includes('/comments/');
    console.log('[Horizon] Setting up title MutationObserver, isPostPage:', isPostPage, 'pathname:', location.pathname);
    
    if (!isPostPage) {
      console.log('[Horizon] Not on post page, skipping title MutationObserver');
      return;
    }
    
    // CAUSE I: Skip overlay/media viewer pages (no title available)
    if (location.pathname.includes('/gallery/') || 
        location.pathname.includes('/media/') ||
        location.search.includes('media=')) {
      console.log('[Horizon] On overlay/media viewer page, skipping title extraction');
      return;
    }
    
    // Try all common Reddit title selectors
    const titleSelectors = [
      'h1[data-testid="post-content"]',
      'h1[data-test-id="post-content"]',
      'h2[data-testid="post-content"]',
      'div[data-testid="post-title"] h1',
      'a[data-testid="post-title"]',
      'a.title',
      'shreddit-post h1',
      'shreddit-post h2',
      '[slot="title"]',
      'faceplate-tracker[source="post"] h1'
    ];
    
    let attempts = 0;
    const maxAttempts = 50; // Stop after 50 mutations (about 5-10 seconds)
    
    // First, try URL extraction immediately (doesn't depend on DOM)
    const urlTitle = extractPostTitleFromUrl();
    if (urlTitle && urlTitle.length > 5 && !isGenericRedditTitle(urlTitle)) {
      console.log('[Horizon] Title extracted from URL immediately:', urlTitle.substring(0, 50));
      currentPostTitle = urlTitle;
      lastUrl = location.href;
      // Don't disconnect observer yet - keep watching for DOM title (might be better formatted)
    }
    
    titleMutationObserver = new MutationObserver(() => {
      attempts++;
      
      if (attempts % 10 === 0) {
        console.log('[Horizon] Title MutationObserver attempt', attempts, 'of', maxAttempts);
      }
      
      // Try to find title using all selectors
      for (const selector of titleSelectors) {
        const titleEl = document.querySelector(selector);
        if (titleEl && titleEl.textContent && titleEl.textContent.trim().length > 5) {
          const extractedTitle = titleEl.textContent.trim();
          if (!isGenericRedditTitle(extractedTitle) && extractedTitle !== currentPostTitle) {
            console.log('[Horizon] Title appeared in DOM via MutationObserver:', extractedTitle.substring(0, 50));
            currentPostTitle = extractedTitle.substring(0, 200);
            lastPostTitle = ''; // Reset to force sending
            lastUrl = location.href;
            
            // Send engagement immediately if we have accumulated time
            if (accumulatedMs > 0) {
              sendEngagement(accumulatedMs);
              accumulatedMs = 0;
              lastSend = Date.now();
            }
            
            titleMutationObserver.disconnect();
            titleMutationObserver = null;
            return;
          }
        }
      }
      
      // Also try URL extraction periodically (in case URL changed)
      if (attempts % 5 === 0) {
        const urlTitle = extractPostTitleFromUrl();
        if (urlTitle && urlTitle.length > 5 && !isGenericRedditTitle(urlTitle) && urlTitle !== currentPostTitle) {
          console.log('[Horizon] Title extracted from URL via MutationObserver:', urlTitle.substring(0, 50));
          currentPostTitle = urlTitle;
          lastPostTitle = '';
          lastUrl = location.href;
          
          if (accumulatedMs > 0) {
            sendEngagement(accumulatedMs);
            accumulatedMs = 0;
            lastSend = Date.now();
          }
          
          // Keep observer running in case DOM title appears (might be better)
        }
      }
      
      // Stop after max attempts to avoid infinite observation
      if (attempts >= maxAttempts) {
        console.log('[Horizon] Title MutationObserver reached max attempts, disconnecting. Current title:', currentPostTitle || 'none');
        titleMutationObserver.disconnect();
        titleMutationObserver = null;
      }
    });
    
    // Observe the document body for changes
    titleMutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false
    });
    
    console.log('[Horizon] Title MutationObserver set up and observing DOM');
  }
  
  // Set up MutationObserver to detect DOM changes (for SPA navigation)
  function setupTitleObserver() {
    if (!settings.includeTitles || !location.hostname.includes('reddit.com')) {
      return;
    }
    
    // Clean up existing observer
    if (titleExtractionObserver) {
      titleExtractionObserver.disconnect();
      titleExtractionObserver = null;
    }
    
    // Create observer to watch for DOM changes that might indicate new post loaded
    titleExtractionObserver = new MutationObserver((mutations) => {
      // Check if URL changed (for SPA navigation)
      if (location.href !== lastUrl) {
        handlePostNavigation();
      }
      
      // Also check if post title elements appeared
      const canonicalUpdater = document.getElementById('canonical_url_updater');
      const redditPageData = document.querySelector('reddit-page-data');
      if (canonicalUpdater || redditPageData) {
        // Post content might have loaded, try extracting title
        const newTitle = extractPostTitle();
        if (newTitle && newTitle.length > 5 && !isGenericRedditTitle(newTitle) && newTitle !== currentPostTitle) {
          console.log('[Horizon] Post title detected via MutationObserver:', newTitle.substring(0, 50));
          currentPostTitle = newTitle;
          lastPostTitle = ''; // Reset to force sending
          lastUrl = location.href;
        }
      }
    });
    
    // Observe the document body for changes
    titleExtractionObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false
    });
  }
  
  // Monitor URL changes for SPA navigation (using popstate and pushState/replaceState)
  let lastUrlCheck = location.href;
  function checkUrlChange() {
    const currentUrl = location.href;
    if (currentUrl !== lastUrlCheck) {
      lastUrlCheck = currentUrl;
      handlePostNavigation();
    }
  }
  
  // Override pushState and replaceState to detect SPA navigation
  if (location.hostname.includes('reddit.com')) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      setTimeout(checkUrlChange, 100);
    };
    
    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      setTimeout(checkUrlChange, 100);
    };
    
    // Also listen for popstate (back/forward navigation)
    window.addEventListener('popstate', () => {
      setTimeout(checkUrlChange, 100);
    });
  }
  
  // Special handling for clicks to detect post navigation (especially for Reddit)
  document.addEventListener('click', (e) => {
    if (!active) updateState(true);
    
    // For Reddit: detect when clicking on post links
    if (location.hostname.includes('reddit.com') && settings.includeTitles) {
      // Check if clicked element is a post link
      const postLink = e.target.closest('a[href*="/r/"], a[href*="/comments/"]');
      if (postLink && postLink.href && postLink.href.includes('/comments/')) {
        console.log('[Horizon] Post link clicked, will detect navigation');
        // handlePostNavigation will be called when URL actually changes
        // Also set up observers if not already set up
        if (!titleExtractionObserver) {
          setupTitleObserver();
        }
        if (!titleMutationObserver) {
          setupTitleMutationObserver(); // CAUSE A: Wait for title to appear
        }
      }
    }
  }, { passive: true });
  
  // Set up URL monitoring for Reddit (always, regardless of settings)
  // The observer will only be active if includeTitles is enabled
  if (location.hostname.includes('reddit.com')) {
    // Check URL periodically as a fallback
    setInterval(checkUrlChange, 1000);
  }

  // periodic flush (sends even if no focus change)
  // Also check for post changes on single-page apps
  setInterval(() => {
    const now = Date.now();
    if (active) {
      accumulatedMs += now - lastChange;
      lastChange = now;
      
      // Check if post title changed (for single-page apps)
      if (settings.includeTitles) {
        // Also check if URL changed (for SPA navigation)
        if (location.href !== lastUrl) {
          handlePostNavigation();
        }
        
        const newPostTitle = extractPostTitle();
        if (newPostTitle && newPostTitle !== currentPostTitle && newPostTitle.length > 5 && !isGenericRedditTitle(newPostTitle)) {
          // Post changed, send accumulated time for previous post
          if (accumulatedMs > 0) {
            sendEngagement(accumulatedMs);
            accumulatedMs = 0;
            lastSend = Date.now();
          }
          currentPostTitle = newPostTitle;
          lastUrl = location.href;
        }
      }
    }
    if (accumulatedMs > 0 && Date.now() - lastSend > SEND_INTERVAL_MS) {
      sendEngagement(accumulatedMs);
      accumulatedMs = 0;
      lastSend = Date.now();
    }
  }, SEND_INTERVAL_MS);

  // final flush on unload
  window.addEventListener('beforeunload', () => {
    if (contextInvalidated) {
      return;
    }
    
    const now = Date.now();
    if (active) {
      accumulatedMs += now - lastChange;
    }
    if (accumulatedMs > 0) {
      // Use sendEngagement which has proper error handling
      sendEngagement(accumulatedMs);
    }
  });
})();
