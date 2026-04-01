/**
 * SEO Article Generator
 *
 * Uses Claude API to generate 1,200-1,700 word SEO-optimized blog posts
 * in the BuySideBrief editorial voice.
 */

const Anthropic = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are Pete, the voice behind Buyside Brief — a free daily newsletter that scans SEC Form 4 insider trading filings and delivers the best signals before market open.

## Your Voice
- Casual, data-forward, self-aware, punchy
- Short sentences. Punch hard, move on.
- Humor as seasoning — not the main course
- No corporate jargon, no clickbait, no false confidence, no hedge-fund-bro tone
- Think: "Smart friend obsessed with SEC filings explaining something over coffee"
- You genuinely care about helping regular investors get an edge
- You respect the reader's intelligence — don't dumb things down, just make them clear

## SEO Requirements (MUST follow all)
- H1 tag containing the primary keyword (one H1 only, at the top)
- Meta description: 150-160 characters, compelling, includes primary keyword
- 3-5 H2 subheadings incorporating secondary/related keywords
- Use H3s under H2s for scanability where appropriate
- Total word count: 1,200-1,700 words (this is critical — do not go under 1,200)
- Primary keyword must appear in the first 100 words
- Include at least 2 internal links using these exact URLs:
  - https://buysidebrief.com — the homepage / subscribe
  - https://buysidebrief.com/archive.html — past newsletter issues
  - https://buysidebrief.com/scorecard.html — performance scorecard
  - https://buysidebrief.com/#subscribe — direct subscribe link
- Naturally mention "Buyside Brief" 1-2 times in the body
- End with a clear CTA encouraging newsletter signup

## Article Structure
1. Hook paragraph — grab attention, set up the problem or question
2. Context section — "why this matters" for investors
3. 2-3 deep content sections — the meat, data-driven, specific examples where possible
4. Practical takeaway — what the reader should actually do with this info
5. CTA section — drive to Buyside Brief newsletter signup

## Output Format
Return semantic HTML only. Use these tags: article, section, h1, h2, h3, p, ul, li, a, strong, em, blockquote.
Do NOT include html, head, or body wrappers. Just the article content.
Do NOT wrap output in markdown code fences.

After the article HTML, include a metadata block in exactly this format:
<!--META {"title": "...", "metaDescription": "...", "slug": "...", "wordCount": N} -->

The slug should be lowercase, hyphenated, 3-8 words, no special characters.`;

function buildUserPrompt({ keyword, category, suggestedTitle, relatedKeywords }) {
  let prompt = `Write an SEO-optimized blog post for the keyword: "${keyword}"

Category: ${category}
Suggested title (you can improve it): ${suggestedTitle || keyword}`;

  if (relatedKeywords && relatedKeywords.length > 0) {
    prompt += `\nRelated keywords to weave in naturally: ${relatedKeywords.join(', ')}`;
  }

  prompt += `

Remember:
- 1,200-1,700 words minimum
- Semantic HTML only (article, section, h1-h3, p, ul, li, a, strong, em, blockquote)
- Include the <!--META {...} --> block at the end
- At least 2 internal links to buysidebrief.com pages
- Primary keyword in the first 100 words and in the H1`;

  return prompt;
}

async function generateArticle({ keyword, category, suggestedTitle, relatedKeywords }) {
  const client = new Anthropic();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildUserPrompt({ keyword, category, suggestedTitle, relatedKeywords }),
    }],
  });

  let raw = message.content[0].text;

  // Strip accidental markdown fences
  raw = raw.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Extract metadata
  const metaMatch = raw.match(/<!--META\s*(\{[\s\S]*?\})\s*-->/);
  let meta = {};
  if (metaMatch) {
    try {
      meta = JSON.parse(metaMatch[1]);
    } catch (e) {
      console.warn('Failed to parse article metadata:', e.message);
    }
  }

  // Content is everything before the META block
  const content = raw.replace(/<!--META[\s\S]*?-->/, '').trim();

  // Count words in content (strip HTML tags)
  const textOnly = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = textOnly.split(/\s+/).length;

  const slug = meta.slug || keyword.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 80);

  return {
    title: meta.title || suggestedTitle || keyword,
    slug,
    metaDescription: meta.metaDescription || '',
    content,
    wordCount,
    keyword,
    category: category || 'general',
    generatedAt: new Date().toISOString(),
  };
}

function wrapArticleInPage(article) {
  const { title, metaDescription, slug, content, wordCount, category, generatedAt } = article;
  const canonicalUrl = `https://buysidebrief.com/blog/${slug}`;
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: metaDescription,
    url: canonicalUrl,
    datePublished: generatedAt,
    dateModified: generatedAt,
    author: { '@type': 'Organization', name: 'Buyside Brief', url: 'https://buysidebrief.com' },
    publisher: { '@type': 'Organization', name: 'Buyside Brief', url: 'https://buysidebrief.com' },
    wordCount,
    articleSection: category,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | Buyside Brief</title>
  <meta name="description" content="${escapeHtml(metaDescription)}">
  <link rel="canonical" href="${canonicalUrl}">

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(metaDescription)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Buyside Brief">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(metaDescription)}">

  <!-- Structured Data -->
  <script type="application/ld+json">${jsonLd}</script>

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      color: #1a1a1a;
      background: #fafaf8;
      line-height: 1.7;
    }
    .site-header {
      background: #2d5016;
      color: #fff;
      padding: 1rem 2rem;
      text-align: center;
    }
    .site-header a { color: #fff; text-decoration: none; font-size: 1.4rem; font-weight: bold; }
    .site-nav { margin-top: 0.4rem; }
    .site-nav a { color: rgba(255,255,255,0.85); margin: 0 0.75rem; font-size: 0.9rem; text-decoration: none; }
    .site-nav a:hover { color: #fff; text-decoration: underline; }
    .container { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
    .meta-line { color: #666; font-size: 0.85rem; margin-bottom: 2rem; font-family: -apple-system, sans-serif; }
    .meta-line .category-badge {
      background: #e8f0e0; color: #2d5016; padding: 0.15rem 0.5rem;
      border-radius: 3px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;
    }
    article h1 { font-size: 2rem; line-height: 1.25; margin-bottom: 0.5rem; color: #111; }
    article h2 { font-size: 1.4rem; margin: 2rem 0 0.75rem; color: #2d5016; }
    article h3 { font-size: 1.15rem; margin: 1.5rem 0 0.5rem; color: #333; }
    article p { margin-bottom: 1.2rem; }
    article ul, article ol { margin: 0 0 1.2rem 1.5rem; }
    article li { margin-bottom: 0.4rem; }
    article a { color: #2d5016; text-decoration: underline; }
    article a:hover { color: #1a3a0a; }
    article blockquote {
      border-left: 3px solid #2d5016; margin: 1.5rem 0; padding: 0.75rem 1.25rem;
      background: #f4f7f0; font-style: italic; color: #444;
    }
    article strong { color: #111; }
    .back-link {
      display: inline-block; margin-bottom: 1.5rem; font-family: -apple-system, sans-serif;
      font-size: 0.9rem; color: #2d5016; text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }
    .site-footer {
      text-align: center; padding: 2rem; color: #888;
      font-size: 0.8rem; font-family: -apple-system, sans-serif; border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <header class="site-header">
    <a href="https://buysidebrief.com">Buyside Brief</a>
    <nav class="site-nav">
      <a href="/blog">Blog</a>
      <a href="https://buysidebrief.com/archive.html">Newsletter Archive</a>
      <a href="https://buysidebrief.com/scorecard.html">Scorecard</a>
      <a href="https://buysidebrief.com/#subscribe">Subscribe</a>
    </nav>
  </header>
  <main class="container">
    <a href="/blog" class="back-link">&larr; Back to Blog</a>
    <div class="meta-line">
      ${dateStr} &middot; ${wordCount} words &middot; <span class="category-badge">${category}</span>
    </div>
    ${content}
  </main>
  <footer class="site-footer">
    &copy; ${new Date().getFullYear()} Buyside Brief &middot;
    <a href="https://buysidebrief.com">Home</a> &middot;
    <a href="https://buysidebrief.com/#subscribe">Subscribe</a>
  </footer>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { generateArticle, wrapArticleInPage };
