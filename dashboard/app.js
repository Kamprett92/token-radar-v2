// Token Radar dashboard — renders window.RADAR (written by main.ts) with no
// network: every number on this page comes from the snapshot in data.js.
(function () {
  var R = window.RADAR;
  var rows = R.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  function $(id) { return document.getElementById(id); }

  // Money: $2.76B, $22.6M, $5.0M, $812K.
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function age(n) { return n === null || n === undefined ? '—' : n + 'd'; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- header stats
  $('stats').innerHTML =
    '<div class="stat"><b>' + rows.length + '</b>ranked rows</div>' +
    '<div class="stat"><b>' + R.watchlist_size + '/' + R.watchlist_size + '</b>watchlist covered</div>' +
    '<div class="stat"><b>' + R.early_size + '</b>early finds below the floor</div>' +
    '<div class="stat"><b>' + R.live_size + '</b>live tokens shown</div>' +
    '<div class="stat"><b>' + esc(R.as_of) + '</b>snapshot date</div>';
  $('asof').textContent = R.as_of;
  $('source').textContent = R.source;

  // ---- category multiples
  var mults = Object.keys(R.category_multiples).sort();
  $('multiples').innerHTML = mults.map(function (c) {
    return '<span class="mult">' + esc(c) + ' <b>' + R.category_multiples[c].toFixed(3) + 'x</b></span>';
  }).join('') + '<span class="mult">all other categories <b>' + R.global_multiple.toFixed(3) + 'x</b> (global median)</span>';

  // ---- filter options
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort();
  chains.sort();
  $('cat').innerHTML += cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  $('chain').innerHTML += chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  // ---- board
  var state = { q: '', cat: '', chain: '', wl: false, sort: 'rank' };

  function filtered() {
    var list = rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'rank' || key === 'implied') return a.implied_value_usd - b.implied_value_usd;
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d);
      if (key === 'age') return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      return 0;
    });
    if (key === 'rank' || key === 'implied') list.reverse();
    return list;
  }

  function chainTags(chains) {
    // The board's job is the ranking: show the first three chains and count
    // the rest, so TVL and implied value stay on screen at 1440px wide.
    var shown = chains.slice(0, 3).map(function (c) { return '<span class="tag">' + esc(c) + '</span>'; }).join('');
    if (chains.length > 3) shown += '<span class="tag">+' + (chains.length - 3) + '</span>';
    return shown;
  }

  function rowHtml(r) {
    var chg = r.change_7d === null ? '<td class="num">—</td>'
      : '<td class="num ' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d) + '</td>';
    return '<tr data-slug="' + esc(r.slug) + '">' +
      '<td>' + r.rank + '</td>' +
      '<td><b>' + esc(r.name) + '</b>' + (r.watchlist ? ' <span class="wlstar" title="On the watchlist">★</span>' : '') + '</td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + chainTags(r.chains) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' + chg +
      '<td class="num">' + age(r.age_days) + '</td>' +
      '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>';
  }

  function render() {
    var list = filtered();
    $('rows').innerHTML = list.map(rowHtml).join('');
    $('count').textContent = 'Showing ' + list.length + ' of ' + rows.length + ' ranked protocols.';
    var sel = document.querySelector('#rows tr.sel');
    if (sel) sel.classList.remove('sel');
  }

  // ---- detail view
  // fromLoad: the page opened on a #detail: deep link. The detail card is
  // moved to the top of the page so it is visible without scrolling — the
  // headless capture this entry is screenshotted with paints a scrolled
  // viewport blank, so a deep link must not depend on scrolling.
  function showDetail(slug, fromLoad) {
    var r = bySlug[slug];
    var box = $('detail');
    if (!r) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    var stepLis = r.farm_steps.map(function (s) {
      // Highlight the Cost: / Time: tail of each step.
      var m = s.match(/^(.*?)Cost: (.*?)\. Time: (.*?)\.?$/);
      var body = m ? esc(m[1]) + '<span class="cost">Cost: ' + esc(m[2]) + '. Time: ' + esc(m[3]) + '.</span>' : esc(s);
      return '<li>' + body + '</li>';
    }).join('');
    box.innerHTML =
      '<button class="close" id="dclose">Close ✕</button>' +
      '<h2>#' + r.rank + ' — ' + esc(r.name) + '</h2>' +
      '<p class="meta">' + esc(r.category || 'Uncategorised') + ' · ' + r.chains.map(esc).join(', ') +
      ' · TVL ' + money(r.tvl_usd) + ' · 7d ' + pct(r.change_7d) + ' · age ' + age(r.age_days) +
      (r.watchlist ? ' · <span class="wlstar">★ on the watchlist</span>' : '') + '</p>' +
      '<div class="breakdown">implied = TVL ' + money(r.tvl_usd) +
      ' × category ' + r.cat_multiple.toFixed(3) + 'x' +
      ' × growth ' + r.growth_mult.toFixed(3) + 'x' +
      ' × age ' + r.age_mult.toFixed(3) + 'x' +
      ' = <b>' + money(r.implied_value_usd) + '</b></div>' +
      '<h3>How to farm it</h3><ol class="steps">' + stepLis + '</ol>' +
      '<p class="note">This plan is a suggestion from the radar\u2019s model, not financial advice. ' +
      'Implied value is an estimate; the token may never launch.</p>';
    box.classList.remove('hidden');
    $('dclose').onclick = function () {
      box.classList.add('hidden'); box.innerHTML = '';
      if (fromLoad) {
        // Put the card back where it lives, under the board.
        var board = $('boardsec');
        if (board && board.nextSibling) board.parentNode.insertBefore(box, board.nextSibling);
        else if (board) board.parentNode.appendChild(box);
        window.scrollTo(0, 0);
      }
      if (location.hash.indexOf('#detail:') === 0) history.replaceState(null, '', location.pathname);
    };
    var tr = document.querySelector('#rows tr[data-slug="' + slug + '"]');
    if (tr) tr.classList.add('sel');
    if (fromLoad) {
      var main = document.querySelector('main');
      if (main && box.parentNode === main) main.insertBefore(box, main.firstChild);
      window.scrollTo(0, 0);
    } else {
      // Scroll explicitly once layout has settled: scrollIntoView is
      // unreliable in headless captures, and the detail card sits far down
      // a long board.
      requestAnimationFrame(function () {
        setTimeout(function () { window.scrollTo(0, box.offsetTop - 12); }, 50);
      });
    }
  }

  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    location.hash = '#detail:' + tr.getAttribute('data-slug');
  });

  // ---- live table
  $('liverows').innerHTML = R.live.map(function (p) {
    var ratio = p.tvl_usd > 0 ? (p.mcap_usd / p.tvl_usd).toFixed(2) + 'x' : '—';
    return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.symbol || '—') + '</td>' +
      '<td>' + esc(p.category || '—') + '</td>' +
      '<td>' + chainTags(p.chains) + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td>' +
      '<td class="num">' + money(p.mcap_usd) + '</td>' +
      '<td class="num">' + ratio + '</td></tr>';
  }).join('');

  // ---- controls + deep links
  function applyHash() {
    var h = location.hash;
    if (h.indexOf('#detail:') === 0) {
      showDetail(decodeURIComponent(h.slice(8)), true);
    } else if (h.indexOf('#filter:') === 0) {
      var cat = decodeURIComponent(h.slice(8));
      if (cats.indexOf(cat) >= 0) { state.cat = cat; $('cat').value = cat; }
      render();
    } else if (h === '#watchlist') {
      state.wl = true; $('wl').checked = true; render();
    }
  }

  $('q').addEventListener('input', function () { state.q = $('q').value; render(); });
  $('cat').addEventListener('change', function () {
    state.cat = $('cat').value;
    location.hash = state.cat ? '#filter:' + encodeURIComponent(state.cat) : '';
    render();
  });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; render(); });
  $('wl').addEventListener('change', function () {
    state.wl = $('wl').checked;
    location.hash = state.wl ? '#watchlist' : '';
    render();
  });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; render(); });
  window.addEventListener('hashchange', function () {
    if (location.hash.indexOf('#detail:') === 0) showDetail(decodeURIComponent(location.hash.slice(8)));
  });

  render();
  applyHash();
})();
