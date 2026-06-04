/* app.js — Pulse — Sprint 3 */

const EMOTION_EMOJI = {
  excited: '🔥', curious: '🤔', nostalgic: '🥹', confused: '😕',
  inspired: '✨', frustrated: '😤', grateful: '🙏', skeptical: '🧐',
  amused: '😄', neutral: '😐',
};

const AVATAR_COLORS = ['av-0', 'av-1', 'av-2', 'av-3', 'av-4'];

let currentTab     = 'url';
let currentSort    = 'relevance';
let currentVideoId = null;
let fetchedComments = [];
let currentQTab    = 'all';

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z]/g, '');
}

// ── TAB + SORT ─────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-url').classList.toggle('active', tab === 'url');
  document.getElementById('tab-paste').classList.toggle('active', tab === 'paste');
  document.getElementById('url-input-view').style.display   = tab === 'url'   ? 'block' : 'none';
  document.getElementById('paste-input-view').style.display = tab === 'paste' ? 'block' : 'none';
}

function setSort(sort) {
  currentSort = sort;
  document.getElementById('sort-top').classList.toggle('active', sort === 'relevance');
  document.getElementById('sort-new').classList.toggle('active', sort === 'time');
}

// ── YOUTUBE HELPERS ────────────────────────────────────────────────────────

function extractVideoId(url) {
  const patterns = [
    /youtube\.com\/watch\?v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /youtube\.com\/embed\/([^?]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchVideoContext(videoId) {
  const url  = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${CONFIG.YOUTUBE_API_KEY}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.items && data.items.length > 0) {
    const snippet = data.items[0].snippet;
    const title   = snippet.title || '';
    const desc    = (snippet.description || '').slice(0, 500);
    return { title, context: `Title: ${title}. Description: ${desc}` };
  }
  return { title: '', context: '' };
}

async function fetchComments(videoId) {
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=50&order=${currentSort}&key=${CONFIG.YOUTUBE_API_KEY}`;
  const res = await fetch(url);

  if (!res.ok) {
    const err = await res.json();
    const msg = err?.error?.message || `YouTube API error ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();

  if (!data.items || data.items.length === 0) {
    throw new Error('No comments found for this video.');
  }

  return data.items.map(item => {
    const c = item.snippet.topLevelComment.snippet;
    return {
      text:      c.textDisplay,
      author:    c.authorDisplayName,
      likes:     c.likeCount,
      commentId: item.snippet.topLevelComment.id,
    };
  });
}

// ── PASTE HELPERS ──────────────────────────────────────────────────────────

function parseComments(raw) {
  return raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

function isSingleComment(lines) {
  return lines.length === 1;
}

// ── PROMPTS ────────────────────────────────────────────────────────────────

function buildSinglePrompt(comment) {
  return `You are an expert YouTube audience analyst. Analyze this single YouTube comment. It may be in English, Hinglish, Telugish, Tanglish or any transliterated Indian language.

Comment:
${comment}

Return ONLY valid JSON:
{
  "summary": {
    "headline": "one sentence capturing what this person is saying (max 12 words)",
    "body": "2-3 sentences explaining the intent, tone, and what they want",
    "tags": ["tag1", "tag2"]
  },
  "emotions": [
    { "emotion": "frustrated", "note": "why they feel this in this comment" }
  ],
  "questions": [
    {
      "exact": "the exact question phrase from the comment",
      "context": "what they were talking about when they asked",
      "category": "Related"
    }
  ],
  "questionStats": {
    "related": 0,
    "unrelated": 0,
    "satirical": 0,
    "dark": 0
  }
}

Rules:
- emotions: all emotions present. Must be from: excited, curious, nostalgic, confused, inspired, frustrated, grateful, skeptical, amused, neutral
- questions: exact phrase only, not full comment. Empty array if none.
- category must be exactly one of: Related, Unrelated, Satirical, Dark
- Raw JSON only, no markdown.`;
}

function buildMultiplePrompt(comments, videoContext = '') {
  const text = comments.map((c, i) => {
    const author = c.author || `Viewer ${i + 1}`;
    const likes  = c.likes  ? ` [${c.likes} likes]` : '';
    const body   = c.text   || c;
    return `${author}${likes}: ${body}`;
  }).join('\n');

  return `You are an expert YouTube audience analyst. Analyze these YouTube comments as a whole. They may be in English, Hinglish, Telugish, Tanglish or any transliterated Indian language.

${videoContext ? `Video context: ${videoContext}` : ''}

Comments:
${text}

Return ONLY valid JSON:
{
  "summary": {
    "headline": "one punchy sentence capturing overall audience mood (max 12 words)",
    "body": "2-3 sentences on what the audience collectively feels and wants",
    "tags": ["tag1", "tag2", "tag3"]
  },
  "emotions": [
    { "emotion": "excited", "percentage": 42, "insight": "brief reason why" }
  ],
  "questions": [
    {
      "exact": "the exact question phrase from within the comment",
      "context": "what they were discussing when they asked this",
      "author": "commenter name",
      "category": "Related"
    }
  ],
  "questionStats": {
    "related": 0,
    "unrelated": 0,
    "satirical": 0,
    "dark": 0
  }
}

Rules:
- emotion percentages must sum to 100
- emotions from: excited, curious, nostalgic, confused, inspired, frustrated, grateful, skeptical, amused, neutral
- questions: you MUST extract EVERY question found. Exact phrase only, not full comment.
- category must be exactly one of: Related, Unrelated, Satirical, Dark
- Related: question is directly about the video topic or content
- Unrelated: genuine but off-topic — about creator personally, gear, future plans
- Satirical: clearly humorous or ironic, not meant literally
- Dark: harmful, violent or deeply negative intent
- Use video context to judge Related vs Unrelated accurately
- questionStats counts must match the actual questions array
- Raw JSON only, no markdown.`;
}

// ── GEMINI ─────────────────────────────────────────────────────────────────

async function callGemini(prompt) {
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}`);

  const data = await res.json();
  const raw  = data.candidates[0].content.parts[0].text
    .replace(/```json|```/g, '').trim();

  return JSON.parse(raw);
}

// ── RENDER ─────────────────────────────────────────────────────────────────

function renderVideoInfo(title, commentCount, sort) {
  const el = document.getElementById('video-info');
  document.getElementById('video-title').textContent = title;
  document.getElementById('video-meta').textContent  =
    `${commentCount} comments analyzed  ·  ${sort === 'relevance' ? 'Top comments' : 'Newest first'}`;
  el.style.display = 'block';
}

function renderSummary(summary) {
  document.getElementById('summary-headline').textContent = summary.headline;
  document.getElementById('summary-body').textContent     = summary.body;
  document.getElementById('summary-tags').innerHTML = (summary.tags || [])
    .map(t => `<span class="summary-tag"><span class="tag-dot"></span>${t}</span>`)
    .join('');
}

function renderEmotionTags(emotions) {
  document.getElementById('emotion-grid').style.display = 'none';
  const wrap = document.getElementById('emotion-tags-view');
  wrap.style.display = 'flex';
  wrap.innerHTML = emotions.map(e => {
    const slug  = slugify(e.emotion);
    const emoji = EMOTION_EMOJI[slug] || '💬';
    return `
      <div class="emotion-tag-card">
        <div class="etag-top">
          <span class="etag-emoji">${emoji}</span>
          <span class="etag-name">${e.emotion}</span>
        </div>
        <div class="etag-note">${e.note || ''}</div>
      </div>`;
  }).join('');
}

function renderEmotionGrid(emotions) {
  document.getElementById('emotion-tags-view').style.display = 'none';
  const grid = document.getElementById('emotion-grid');
  grid.style.display = 'grid';
  grid.innerHTML = emotions.slice(0, 6).map((e, i) => {
    const slug  = slugify(e.emotion);
    const emoji = EMOTION_EMOJI[slug] || '💬';
    return `
      <div class="emotion-tile stagger" style="animation-delay:${0.05 + i * 0.07}s">
        <div class="et-bar ef-${slug}"></div>
        <div class="emotion-tile-top">
          <div class="emotion-name">${e.emotion}</div>
          <div class="emotion-emoji">${emoji}</div>
        </div>
        <div class="emotion-pct">${e.percentage}<span>%</span></div>
        <div class="emotion-insight">${e.insight || ''}</div>
        <div class="emotion-track">
          <div class="emotion-fill ef-${slug}" style="width:${e.percentage}%"></div>
        </div>
      </div>`;
  }).join('');
}

function renderQuestionStats(stats) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total === 0) return;

  const pct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;

  document.getElementById('question-stats').innerHTML = `
    <span class="qstat related">Related ${pct(stats.related)}%</span>
    <span class="qstat unrelated">Unrelated ${pct(stats.unrelated)}%</span>
    <span class="qstat satirical">Satirical ${pct(stats.satirical)}%</span>
    ${stats.dark > 0 ? `<span class="qstat dark">Dark ${pct(stats.dark)}%</span>` : ''}
  `;

  document.getElementById('tab-all').textContent        = `All (${total - stats.dark})`;
  document.getElementById('tab-related').textContent    = `Related (${stats.related})`;
  document.getElementById('tab-unrelated').textContent  = `Unrelated (${stats.unrelated})`;
  document.getElementById('tab-satirical').textContent  = `Satirical (${stats.satirical})`;
}

function switchQTab(tab) {
  currentQTab = tab;
  ['all', 'related', 'unrelated', 'satirical'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
  });

  document.querySelectorAll('.q-card').forEach(card => {
    const cat = card.dataset.category?.toLowerCase();
    if (tab === 'all') {
      card.style.display = cat === 'dark' ? 'none' : 'grid';
    } else {
      card.style.display = cat === tab ? 'grid' : 'none';
    }
  });
}

function toggleDark() {
  const list  = document.getElementById('dark-list');
  const arrow = document.getElementById('dark-arrow');
  const open  = list.style.display === 'block';
  list.style.display = open ? 'none' : 'block';
  arrow.textContent  = open ? '▼' : '▲';
}

function renderQuestions(questions, videoId) {
  const section = document.getElementById('questions-section');
  if (!questions || questions.length === 0) {
    section.style.display = 'none';
    document.getElementById('dark-section').style.display = 'none';
    return;
  }

  const mainQs = questions.filter(q => q.category !== 'Dark');
  const darkQs = questions.filter(q => q.category === 'Dark');

  section.style.display = mainQs.length > 0 ? 'block' : 'none';

  document.getElementById('questions-list').innerHTML = mainQs.map((q, i) => {
    const match = fetchedComments.find(c =>
      c.text.toLowerCase().includes(q.exact.toLowerCase().trim()) ||
      c.text.toLowerCase().includes(q.exact.toLowerCase().slice(0, 20)) ||
      (() => {
        const words = q.exact.toLowerCase().split(' ').filter(w => w.length > 3);
        const chunk = words.slice(0, 3).join(' ');
        return chunk && c.text.toLowerCase().includes(chunk);
      })() ||
      (q.author ? c.author.toLowerCase().includes(q.author.toLowerCase()) : false)
    );
    const commentId = match?.commentId || '';
    const url = (videoId && commentId)
      ? `https://youtube.com/watch?v=${videoId}&lc=${commentId}`
      : null;
    const cat = (q.category || 'related').toLowerCase();

    return `
      <div class="q-card stagger" data-category="${cat}" style="animation-delay:${i * 0.08}s">
        <div class="q-content">
          <div class="q-author">
            ${q.author || ''}
            <span class="q-cat-badge ${cat}">${q.category}</span>
          </div>
          <div class="q-exact">"${q.exact}"</div>
          <div class="q-context">${q.context}</div>
        </div>
        ${url
          ? `<a href="${url}" target="_blank" style="text-decoration:none"><button class="reply-btn">Reply ↗</button></a>`
          : `<button class="reply-btn" style="opacity:.4;cursor:not-allowed">Reply ↗</button>`}
      </div>`;
  }).join('');

  // Dark section
  const darkSec = document.getElementById('dark-section');
  if (darkQs.length > 0) {
    darkSec.style.display = 'block';
    document.getElementById('dark-count').textContent = `Dark Comments (${darkQs.length})`;
    document.getElementById('dark-list').innerHTML = darkQs.map(q => `
      <div class="q-card dark-card">
        <div class="q-content">
          ${q.author ? `<div class="q-author">${q.author}</div>` : ''}
          <div class="q-exact">"${q.exact}"</div>
          <div class="q-context">${q.context}</div>
        </div>
      </div>`).join('');
  } else {
    darkSec.style.display = 'none';
  }

  currentQTab = 'all';
}

// ── UI STATE ───────────────────────────────────────────────────────────────

function setLoading(on) {
  const btn  = document.getElementById('analyze-btn');
  const text = document.getElementById('btn-text');
  const icon = document.getElementById('btn-icon');
  btn.disabled     = on;
  text.textContent = on ? 'Analyzing' : 'Analyze';
  icon.innerHTML   = on ? '<div class="spinner"></div>' : '→';
  icon.className   = on ? '' : 'btn-arrow';
}

function showError(msg) {
  const box = document.getElementById('error-box');
  box.textContent   = msg;
  box.style.display = 'block';
}

function hideError() {
  document.getElementById('error-box').style.display = 'none';
}

function resetResults() {
  document.getElementById('results').classList.remove('visible');
  document.getElementById('video-info').style.display = 'none';
  currentVideoId  = null;
  fetchedComments = [];
  currentQTab     = 'all';
}

// ── ANALYZE ────────────────────────────────────────────────────────────────

async function analyze() {
  hideError();
  resetResults();
  currentTab === 'url' ? await analyzeUrl() : await analyzePaste();
}

async function analyzeUrl() {
  const raw = document.getElementById('url-input').value.trim();
  if (!raw) { showError('Please paste a YouTube URL.'); return; }

  const videoId = extractVideoId(raw);
  if (!videoId) { showError('Could not find a valid YouTube video ID in that URL.'); return; }

  setLoading(true);

  try {
    const [{ title, context }, comments] = await Promise.all([
      fetchVideoContext(videoId),
      fetchComments(videoId),
    ]);

    currentVideoId  = videoId;
    fetchedComments = comments;

    const result = await callGemini(buildMultiplePrompt(comments, context));

    renderVideoInfo(title || 'YouTube Video', comments.length, currentSort);
    renderSummary(result.summary);
    renderEmotionGrid(result.emotions || []);

    if (result.questionStats) renderQuestionStats(result.questionStats);
    renderQuestions(result.questions || [], videoId);

    showResults();
  } catch (err) {
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
}

async function analyzePaste() {
  const raw = document.getElementById('comments-input').value.trim();
  if (!raw) { showError('Please paste some comments first.'); return; }

  const lines  = parseComments(raw);
  const single = isSingleComment(lines);
  const prompt = single ? buildSinglePrompt(lines[0]) : buildMultiplePrompt(lines);

  setLoading(true);

  try {
    const result = await callGemini(prompt);

    renderSummary(result.summary);
    single ? renderEmotionTags(result.emotions || []) : renderEmotionGrid(result.emotions || []);

    if (result.questionStats) renderQuestionStats(result.questionStats);
    renderQuestions(result.questions || [], null);

    showResults();
  } catch (err) {
    showError(err.message || 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
}

function showResults() {
  const results = document.getElementById('results');
  results.classList.add('visible');
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── INIT ───────────────────────────────────────────────────────────────────

document.getElementById('analyze-btn').addEventListener('click', analyze);
document.getElementById('comments-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyze();
});
document.getElementById('url-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});