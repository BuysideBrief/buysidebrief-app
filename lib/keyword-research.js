/**
 * SEO Keyword Research Engine
 *
 * Expands seed keywords via Google Autocomplete, scores by intent/competition,
 * and generates a 30-day content calendar for the BuySideBrief blog.
 */

const https = require('https');

// ---------------------------------------------------------------------------
// Seed Keywords
// ---------------------------------------------------------------------------

const SEED_KEYWORDS = [
  // Core insider trading
  'insider trading signals',
  'SEC insider buying',
  'insider buying stocks',
  'insider trading tracker',
  'insider trading alerts',
  'insider buying today',
  'insider selling stocks',
  'insider trading data',
  'insider ownership changes',
  'corporate insider buying',

  // SEC Form 4 / EDGAR education
  'SEC Form 4 filing',
  'how to read SEC Form 4',
  'EDGAR insider trading',
  'SEC EDGAR tutorial',
  'Form 4 transaction codes',
  'Form 4 vs Form 3',
  'SEC filing types explained',
  'how to use EDGAR',
  'SEC EDGAR full text search',

  // Stock-specific patterns
  'cluster insider buying',
  'insider buying near 52 week low',
  'pre earnings insider buying',
  'CEO buying own stock',
  'director stock purchases',
  'insider buying small cap stocks',
  'insider buying penny stocks',
  'unusual insider activity',
  'insider accumulation pattern',

  // Competitor / alternative queries
  'openinsider alternative',
  'secform4 alternative',
  'gurufocus insider trading',
  'insider trading newsletter',
  'best insider trading website',
  'free insider trading data',
  'insider trading screener',

  // Finance education
  'how to follow smart money',
  'smart money stock picks',
  'institutional vs insider buying',
  'why insiders buy stock',
  'insider trading legal vs illegal',
];

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

function fetchAutocompleteSuggestions(query) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query);
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encoded}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Array.isArray(parsed[1]) ? parsed[1] : []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

// ---------------------------------------------------------------------------
// Keyword Expansion
// ---------------------------------------------------------------------------

const PREFIXES = ['best', 'free', 'how to', 'what is', 'top', 'latest'];
const SUFFIXES = ['2026', 'today', 'this week', 'for beginners', 'explained', 'guide', 'tool', 'newsletter'];

function expandKeyword(seed) {
  const expanded = [seed];
  for (const p of PREFIXES) expanded.push(`${p} ${seed}`);
  for (const s of SUFFIXES) expanded.push(`${seed} ${s}`);
  return expanded;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const HIGH_INTENT_TERMS = ['newsletter', 'tracker', 'alert', 'tool', 'screener', 'app', 'service', 'platform', 'subscription'];
const INSIDER_TERMS = ['insider', 'form 4', 'sec', 'edgar', 'filing', 'insider trading', 'insider buying', 'insider selling'];
const RECENCY_TERMS = ['2026', 'today', 'this week', 'latest', 'recent', 'new'];
const COMPARISON_TERMS = ['alternative', 'vs', 'compared', 'better than', 'best', 'top'];

function scoreKeyword(keyword, autocompleteCount) {
  const kw = keyword.toLowerCase();
  let score = 0;

  // Autocomplete presence — up to 40pts
  score += Math.min(autocompleteCount * 8, 40);

  // Word count / long-tail bonus — 15-25pts
  const wordCount = kw.split(/\s+/).length;
  if (wordCount >= 5) score += 25;
  else if (wordCount >= 4) score += 20;
  else if (wordCount >= 3) score += 15;

  // Question format — 15pts
  if (/^(how|what|why|when|where|which|can|do|does|is|are|should)\b/.test(kw)) score += 15;

  // High-intent commercial terms — 20pts
  if (HIGH_INTENT_TERMS.some((t) => kw.includes(t))) score += 20;

  // Direct relevance to insider trading — 15pts
  if (INSIDER_TERMS.some((t) => kw.includes(t))) score += 15;

  // Recency signals — 10pts
  if (RECENCY_TERMS.some((t) => kw.includes(t))) score += 10;

  // Comparison / alternative keywords — 25pts
  if (COMPARISON_TERMS.some((t) => kw.includes(t))) score += 25;

  return Math.min(score, 100);
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

function categorizeKeyword(keyword) {
  const kw = keyword.toLowerCase();
  if (/^(how|what|why|when|where|which)\b/.test(kw) || /explained|tutorial|basics|101/.test(kw)) return 'educational';
  if (/alternative|vs|compared|better than|replace/.test(kw)) return 'comparison';
  if (/2026|today|this week|latest|recent|now/.test(kw)) return 'timely';
  if (/tool|app|tracker|screener|newsletter|platform|service|alert/.test(kw)) return 'product';
  if (/guide|step|beginner|learn|start/.test(kw)) return 'guide';
  return 'general';
}

// ---------------------------------------------------------------------------
// Full Research Pipeline
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runKeywordResearch(options = {}) {
  const { maxAutocompleteQueries = 40, minScore = 20 } = options;

  // 1. Expand seeds
  const allKeywords = new Set();
  for (const seed of SEED_KEYWORDS) {
    for (const kw of expandKeyword(seed)) {
      allKeywords.add(kw.toLowerCase());
    }
  }
  console.log(`  Expanded to ${allKeywords.size} unique keywords`);

  // 2. Fetch autocomplete for up to N seeds
  const autocompleteMap = new Map();
  const seedsToQuery = SEED_KEYWORDS.slice(0, maxAutocompleteQueries);
  let queried = 0;
  for (const seed of seedsToQuery) {
    const suggestions = await fetchAutocompleteSuggestions(seed);
    for (const s of suggestions) {
      allKeywords.add(s.toLowerCase());
      autocompleteMap.set(s.toLowerCase(), (autocompleteMap.get(s.toLowerCase()) || 0) + 1);
    }
    queried++;
    if (queried % 10 === 0) console.log(`  Autocomplete: ${queried}/${seedsToQuery.length}`);
    await sleep(200);
  }
  console.log(`  Autocomplete done — ${autocompleteMap.size} suggestions collected`);

  // 3. Score and filter
  const results = [];
  for (const kw of allKeywords) {
    const hits = autocompleteMap.get(kw) || 0;
    const score = scoreKeyword(kw, hits);
    if (score >= minScore) {
      results.push({
        keyword: kw,
        score,
        category: categorizeKeyword(kw),
        autocompleteHits: hits,
        source: SEED_KEYWORDS.includes(kw) ? 'seed' : (hits > 0 ? 'autocomplete' : 'expansion'),
        wordCount: kw.split(/\s+/).length,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  console.log(`  ${results.length} keywords scored above ${minScore}`);
  return results;
}

// ---------------------------------------------------------------------------
// Content Calendar
// ---------------------------------------------------------------------------

const DAY_CATEGORY_MAP = {
  1: 'educational', // Monday
  2: 'product',     // Tuesday
  3: 'guide',       // Wednesday
  4: 'comparison',  // Thursday
  5: 'timely',      // Friday
};

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function suggestTitle(keyword, category) {
  const kw = keyword.charAt(0).toUpperCase() + keyword.slice(1);
  switch (category) {
    case 'educational': return `${kw}: What Every Investor Should Know`;
    case 'comparison': return `${kw} — An Honest Breakdown`;
    case 'timely': return `${kw}: What the Data Shows Right Now`;
    case 'product': return `${kw}: Tools That Actually Work`;
    case 'guide': return `${kw}: A Practical Guide`;
    default: return `${kw}: The Insider's Perspective`;
  }
}

function generateContentCalendar(keywords, options = {}) {
  const { days = 30, postsPerDay = 1 } = options;
  const totalPosts = days * postsPerDay;

  // Bucket keywords by category
  const buckets = {};
  for (const kw of keywords) {
    if (!buckets[kw.category]) buckets[kw.category] = [];
    buckets[kw.category].push(kw);
  }

  const calendar = [];
  const used = new Set();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 1); // Start tomorrow

  for (let i = 0; i < totalPosts; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + Math.floor(i / postsPerDay));
    const dayOfWeek = date.getDay(); // 0=Sun
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];

    // Preferred category for this day, fallback to any
    const preferredCategory = DAY_CATEGORY_MAP[dayOfWeek] || 'general';
    let picked = null;

    // Try preferred category first, then any
    for (const cat of [preferredCategory, ...Object.keys(buckets)]) {
      const bucket = buckets[cat] || [];
      for (const kw of bucket) {
        if (!used.has(kw.keyword)) {
          picked = kw;
          used.add(kw.keyword);
          break;
        }
      }
      if (picked) break;
    }

    if (!picked) break; // Out of keywords

    const title = suggestTitle(picked.keyword, picked.category);
    calendar.push({
      day: i + 1,
      date: date.toISOString().split('T')[0],
      dayOfWeek: dayName,
      keyword: picked.keyword,
      category: picked.category,
      score: picked.score,
      suggestedTitle: title,
      suggestedSlug: slugify(title),
    });
  }

  return calendar;
}

module.exports = {
  SEED_KEYWORDS,
  fetchAutocompleteSuggestions,
  expandKeyword,
  scoreKeyword,
  categorizeKeyword,
  runKeywordResearch,
  generateContentCalendar,
};
