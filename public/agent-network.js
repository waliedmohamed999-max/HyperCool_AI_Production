// Agent Network section — vanilla JS, zero dependencies (matches this static site's existing
// stack: no bundler, no framework). Renders the agent orchestration diagram from ONE data
// array (AGENTS + FROST below) so it can later be pointed at a real backend endpoint without
// touching markup — see the module doc in home.html's comment above this section.
//
// Real roster note: HyperCool markets 12 total agents = Frost + 11 specialists (see
// src/domain.js — frost_commander is the 13th, internal-only Command Center helper, never
// public-marketed). This file keeps that real count; it does not add a 12th specialist
// alongside a separately-counted Frost, since that would overstate the real product by one.
//
// Everything here is presentational/illustrative: the "live automation demo" is a scripted
// mock (clearly labeled with a caption-note, same honesty convention already used elsewhere on
// this page for the how-it-works table), never a claim of a live data feed.
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- Icons (24x24, stroke=currentColor — same convention as the channel-badge icons above) --
  var ICONS = {
    frost: '<path d="M4 15c2-5 4-9 8-9s6 4 8 9c-2 2-5 3-8 3s-6-1-8-3Z"/>',
    strategy: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>',
    copy: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3"/><path d="M9 12h6M9 16h6"/>',
    creative: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="M21 16l-5-5-4 4-2-2-4 4"/>',
    compliance: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/><path d="M9 12l2 2 4-4"/>',
    publishing: '<path d="M4 5h4l2 3h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5Z"/>',
    leads: '<path d="M4 4h16l-6 8v6l-4 2v-8L4 4Z"/>',
    sales: '<path d="M4 5h16v11H9l-4 3v-3H4z"/><path d="M8 9h8M8 12h5"/>',
    followup: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    intelligence: '<path d="M4 19l5-6 4 3 7-9"/><path d="M15 7h5v5"/>',
    performance: '<path d="M5 20V12M12 20V6M19 20v-8"/><path d="M2 20h20"/>',
    memory: '<circle cx="12" cy="12" r="8"/><path d="M12 4a5 5 0 0 1 0 10 5 5 0 0 0 0 10"/>',
    commander: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    lightbulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
    approval: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21c0-3.5 3-6 7-6s7 2.5 7 6"/>',
    publish2: '<path d="M21 3L3 10.5l7 2.5 2 7L21 3Z"/><path d="M12.5 13.5L21 3"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
    whatsapp: '<path d="M12 21c-1.6 0-3.1-.4-4.4-1.2L3 21l1.3-4.4A8.9 8.9 0 1 1 12 21Z"/>',
    play: '<path d="M8 5.5v13l11-6.5-11-6.5Z"/>',
    sparkle: '<path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3Z"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"/>'
  };

  // Real, distinct color per agent — a purely visual identifier (icon badge + its connection
  // line color), not a status. Status (active/pending/idle) is conveyed separately via the
  // dot + text label below, never by this color alone.
  var FROST = {
    id: 'frost', name: 'Frost', icon: 'frost', status: 'ok', color: '#7c3aed',
    description: 'إدارة المنظومة وتوجيه الوكلاء',
    when: 'مستمر — يستقبل كل طلب جديد ويقرر أي وكيل يتولاه.',
    tools: ['قراءة حالة النظام', 'توزيع المهام', 'المراقبة', 'المراجعة'],
    receivesFrom: ['طلبك أو حدث داخل النظام'],
    sendsTo: ['الوكيل المتخصص المناسب للمهمة'],
    requiresApproval: false
  };

  var AGENTS = [
    { id: 'strategy', name: 'استراتيجية المحتوى', icon: 'strategy', status: 'ok', side: 'right', color: '#f97316',
      description: 'يحدد الرسائل والقنوات',
      when: 'عند تخطيط حملة أو تقويم محتوى جديد.',
      tools: ['قراءة أهداف الحملة', 'تحليل السوق', 'اقتراح خطة محتوى'],
      receivesFrom: ['Frost', 'رصد السوق'], sendsTo: ['كتابة المحتوى'], requiresApproval: false },
    { id: 'compliance', name: 'مراجعة الامتثال', icon: 'compliance', status: 'ok', side: 'right', color: '#0ea5e9',
      description: 'يتحقق قبل التنفيذ',
      when: 'قبل أي عرض على فريقك للاعتماد.',
      tools: ['فحص الأسعار والمواصفات', 'كشف الادعاءات غير الموثقة'], receivesFrom: ['كتابة المحتوى', 'التصميم'],
      sendsTo: ['Frost', 'فريقك للاعتماد'], requiresApproval: false },
    { id: 'publishing', name: 'النشر والجدولة', icon: 'publishing', status: 'pending', side: 'right', color: '#f43f5e',
      description: 'ينشر المحتوى المعتمد',
      when: 'فقط بعد موافقة بشرية على المحتوى.',
      tools: ['نشر مجدول على القنوات المتصلة'], receivesFrom: ['موافقتك'],
      sendsTo: ['القنوات الخارجية (واتساب، ميتا، إكس...)'], requiresApproval: true },
    { id: 'sales', name: 'المحادثات والمبيعات', icon: 'sales', status: 'ok', side: 'right', color: '#a855f7',
      description: 'يؤهل العميل ويحرك الصفقة',
      when: 'فور تسليم ملخص عميل مؤهل.',
      tools: ['الرد المؤهل', 'تحديث حالة الصفقة'], receivesFrom: ['العملاء المحتملون'],
      sendsTo: ['المتابعة', 'Frost'], requiresApproval: false },
    { id: 'intelligence', name: 'رصد السوق', icon: 'intelligence', status: 'ok', side: 'right', color: '#22c55e',
      description: 'يراقب السوق والمنافسين',
      when: 'بشكل دوري ومستمر، أو عند طلب Frost.',
      tools: ['تحليل السوق والمنافسين'], receivesFrom: ['مصادر خارجية معتمدة'],
      sendsTo: ['استراتيجية المحتوى', 'Frost'], requiresApproval: false },
    { id: 'followup', name: 'المتابعة', icon: 'followup', status: 'pending', side: 'right', color: '#14b8a6',
      description: 'يتابع بعد موافقة العميل',
      when: 'فقط بعد موافقة صريحة من العميل على التواصل.',
      tools: ['جدولة تذكير', 'إرسال متابعة بعد الموافقة'], receivesFrom: ['المحادثات والمبيعات'],
      sendsTo: ['العميل (بعد الموافقة)'], requiresApproval: true },
    { id: 'copy', name: 'كتابة المحتوى', icon: 'copy', status: 'ok', side: 'left', color: '#3b82f6',
      description: 'صياغة المحتوى لكل قناة',
      when: 'بعد اعتماد خطة المحتوى، لكل منشور مطلوب.',
      tools: ['توليد نص عربي/إنجليزي'], receivesFrom: ['استراتيجية المحتوى', 'Frost'],
      sendsTo: ['التصميم', 'مراجعة الامتثال'], requiresApproval: false },
    { id: 'creative', name: 'التصميم', icon: 'creative', status: 'ok', side: 'left', color: '#ec4899',
      description: 'تصاميم وصور وفيديوهات',
      when: 'بعد جاهزية نص المحتوى.',
      tools: ['توليد أصول بصرية', 'سيناريوهات فيديو'], receivesFrom: ['كتابة المحتوى'],
      sendsTo: ['مراجعة الامتثال'], requiresApproval: false },
    { id: 'leads', name: 'العملاء المحتملون', icon: 'leads', status: 'ok', side: 'left', color: '#8b5cf6',
      description: 'فرز وتأهيل العملاء',
      when: 'عند وصول تواصل جديد من أي قناة.',
      tools: ['فرز الاهتمام', 'تجهيز ملخص العميل'], receivesFrom: ['القنوات المتصلة'],
      sendsTo: ['المحادثات والمبيعات'], requiresApproval: false },
    { id: 'performance', name: 'قياس الأداء', icon: 'performance', status: 'ok', side: 'left', color: '#6366f1',
      description: 'تحليل النتائج والتحسين',
      when: 'بعد كل دورة نشر، وفي التقرير الأسبوعي.',
      tools: ['تحليل نتائج القنوات الحقيقية'], receivesFrom: ['نتائج القنوات المتصلة'],
      sendsTo: ['Frost'], requiresApproval: false },
    { id: 'memory', name: 'ذاكرة العلامة', icon: 'memory', status: 'idle', side: 'left', color: '#475569',
      description: 'يحفظ المعرفة المعتمدة',
      when: 'يُستدعى كمرجع من أي وكيل آخر.',
      tools: ['حفظ المعلومات المعتمدة', 'استرجاعها للوكلاء'], receivesFrom: ['كل الوكلاء (بعد الاعتماد)'],
      sendsTo: ['كل الوكلاء (كمرجع)'], requiresApproval: false },
    // The 13th real registry agent (see src/runtime/registry.js's seedRegistry — 13 agents
    // total). Genuinely exists and is already user-facing via the real "غرفة القيادة" /
    // Command Center feature; included here (not previously shown on this marketing page) so
    // the 12-specialist count is both honest and evenly split 6/6, matching "بقيادة Frost" —
    // Frost as the leader, distinct from (not one of) the 12 it leads.
    { id: 'frost_commander', name: 'مساعد غرفة القيادة', icon: 'commander', status: 'ok', side: 'left', color: '#f59e0b',
      description: 'يجيب من بيانات النظام',
      when: 'عند سؤال مباشر داخل غرفة القيادة.',
      tools: ['قراءة حالة النظام', 'الإجابة على استفسارات الأداء', 'تنفيذ إجراءات محدودة'],
      receivesFrom: ['سؤالك المباشر في غرفة القيادة'], sendsTo: ['إجابة فورية، أو طلب موافقتك لإجراء محدد'],
      requiresApproval: true }
  ];

  // One-word status labels everywhere — same compact style, same visual weight. The full
  // "requires approval before it acts" explanation already lives in the card's own tooltip
  // and detail panel, so the badge itself doesn't need to spell it out again.
  var STATUS_LABEL = { ok: 'نشط', pending: 'بانتظار', idle: 'مرجعي' };

  var DEMO_STEPS = [
    { id: 'frost', label: 'Frost', note: 'يستقبل الطلب ويحدد المسار' },
    { id: 'leads', label: 'العملاء المحتملون', note: 'فرز الاهتمام وتجهيز الملخص' },
    { id: 'sales', label: 'المحادثات والمبيعات', note: 'تأهيل العميل والرد' },
    { id: 'followup', label: 'المتابعة', note: 'بانتظار موافقة العميل على المتابعة' }
  ];

  // 7 major steps for the default marketing view — combines the full internal 11-step flow
  // into a comprehensible story (idea -> Frost -> content -> review -> approval -> results).
  // The detailed step-by-step breakdown lives in the compact "live demo" chips below instead
  // of forcing all 11 into one unreadable row.
  var WORKFLOW_STEPS = [
    { label: 'فكرة أو Lead', note: 'من عميل أو بيانات جديدة', icon: 'lightbulb', color: '#0ea5e9' },
    { label: 'Frost يحلل الهدف', note: 'ويوزّع المهام', icon: 'frost', color: '#7c3aed' },
    { label: 'استراتيجية ومحتوى', note: 'تخطيط وصياغة الرسائل', icon: 'strategy', color: '#f97316' },
    { label: 'التصميم', note: 'إنشاء الأصول البصرية', icon: 'creative', color: '#ec4899' },
    { label: 'مراجعة الامتثال', note: 'تدقيق قبل الاعتماد', icon: 'compliance', color: '#0ea5e9' },
    { label: 'موافقتك والنشر', note: 'تنفيذ بعد اعتمادك', icon: 'approval', color: '#f43f5e', approval: true },
    { label: 'قياس النتائج', note: 'Frost يحسّن الجولة التالية', icon: 'performance', color: '#8b5cf6' }
  ];

  // Single illustrative example — a fixed incoming event, not a rotating news ticker. Rotating
  // through unrelated topics (e.g. a content-approval item) undercut the "new lead" story this
  // card exists to tell, so this stays one honest, clearly-labeled demo example.
  var EVENT = { title: 'Lead جديد', sub: 'وصل عبر واتساب · B2B · 45,000 ريال', icon: 'whatsapp', color: '#22c55e' };

  function svgIcon(key) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[key] || '') + '</svg>';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildTooltip(agent) {
    var html = '<strong>يستقبل من</strong><p>' + escapeHtml(agent.receivesFrom.join('، ')) + '</p>' +
      '<strong>يرسل إلى</strong><p>' + escapeHtml(agent.sendsTo.join('، ')) + '</p>' +
      '<strong>الصلاحيات</strong><p>' + escapeHtml(agent.tools.join('، ')) + '</p>';
    if (agent.requiresApproval) html += '<p><strong class="ann-tooltip-approval">يتطلب موافقتك قبل أي إجراء خارجي</strong></p>';
    return html;
  }

  function buildNode(agent, number) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'ann-node';
    node.dataset.agentId = agent.id;
    node.dataset.side = agent.side;
    node.style.setProperty('--ann-color', agent.color);
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('aria-label', agent.name + ' — ' + agent.description);
    node.innerHTML =
      '<span class="ann-node-icon">' + svgIcon(agent.icon) + '</span>' +
      '<span class="ann-node-body">' +
        '<span class="ann-node-top"><span class="ann-node-number">' + String(number).padStart(2, '0') + '</span><strong>' + escapeHtml(agent.name) + '</strong></span>' +
        '<span>' + escapeHtml(agent.description) + '</span>' +
      '</span>' +
      '<span class="ann-node-status ann-node-status-' + agent.status + '"><span class="status-dot ' + (agent.status === 'ok' ? 'ok' : agent.status === 'pending' ? 'pending' : 'idle') + '" aria-hidden="true"></span>' + STATUS_LABEL[agent.status] + '</span>' +
      '<span class="ann-tooltip" role="tooltip">' + buildTooltip(agent) + '</span>';
    return node;
  }

  // NOTE: `node.style.setProperty` above sets a custom PROPERTY (a CSS variable), not a
  // style declaration — this is exempt from the `style-src` CSP directive (which only governs
  // actual property values/declarations, not custom-property assignment via the CSSOM), unlike
  // `style="..."` attributes or `.style.color=`, both avoided everywhere else in this file.

  function renderNodes() {
    var mount = document.getElementById('ann-nodes');
    if (!mount) return;
    var grid = document.createElement('div');
    grid.className = 'ann-grid';

    var right = document.createElement('div');
    right.className = 'ann-side ann-side-right';
    var left = document.createElement('div');
    left.className = 'ann-side ann-side-left';

    var leftAgents = AGENTS.filter(function (a) { return a.side === 'left'; });
    var rightAgents = AGENTS.filter(function (a) { return a.side === 'right'; });
    leftAgents.forEach(function (agent, i) { left.appendChild(buildNode(agent, i + 1)); });
    rightAgents.forEach(function (agent, i) { right.appendChild(buildNode(agent, leftAgents.length + i + 1)); });

    var core = document.createElement('button');
    core.type = 'button';
    core.className = 'ann-core';
    core.id = 'ann-frost-core';
    core.setAttribute('aria-haspopup', 'dialog');
    core.setAttribute('aria-label', 'Frost — المتحكم الذكي، اضغط لعرض التفاصيل');
    core.innerHTML =
      '<span class="ann-core-ring ann-core-ring-3" aria-hidden="true"></span>' +
      '<span class="ann-core-ring" aria-hidden="true"></span>' +
      '<span class="ann-core-ring ann-core-ring-2" aria-hidden="true"></span>' +
      '<span class="ann-core-logo" aria-hidden="true">' + svgIcon('frost') + '</span>' +
      '<strong>Frost</strong>' +
      '<span class="ann-core-subtitle">المتحكم الذكي</span>' +
      '<span class="ann-core-caption">يخطط • يوزّع • يراجع • يحسّن</span>' +
      '<span class="ann-core-status"><span class="status-dot ok" aria-hidden="true"></span>يعمل الآن</span>' +
      '<span class="ann-core-count">' + AGENTS.length + '/' + AGENTS.length + ' وكيل متصل</span>';

    grid.appendChild(right);
    grid.appendChild(core);
    grid.appendChild(left);
    mount.appendChild(grid);
  }

  function agentById(id) {
    if (id === 'frost') return FROST;
    for (var i = 0; i < AGENTS.length; i++) if (AGENTS[i].id === id) return AGENTS[i];
    return null;
  }

  // --- Scale-to-fit scene: the whole composition (#ann-scene, fixed 1560px wide) is scaled
  // down as one unit on narrow viewports instead of being reflowed — see the CSS comment on
  // .ann-scene-stage/.ann-scene. This keeps the exact desktop layout at every screen size.
  var SCENE_WIDTH = 1560;
  var currentScale = 1;

  function initSceneScale() {
    var stage = document.getElementById('ann-scene-stage');
    var scene = document.getElementById('ann-scene');
    if (!stage || !scene) return;
    var stageWidth = stage.getBoundingClientRect().width;
    var scale = stageWidth > 0 ? Math.min(1, stageWidth / SCENE_WIDTH) : 1;
    currentScale = scale;
    scene.style.setProperty('--scene-scale', scale);
    // Also set on the root element, not just the scene itself, so sections AFTER #agents
    // (e.g. .stats-wrap's negative margin-top, see styles.css) can stay proportional to the
    // same scale — a fixed screen-pixel overlap designed for the full-size scene would eat
    // into a much bigger fraction of the content once the whole scene is shrunk on mobile.
    document.documentElement.style.setProperty('--scene-scale', scale);
    // offsetHeight is the scene's LAYOUT (pre-transform) height — transform:scale never
    // changes it — so this is the true natural height of the 1560px-wide content.
    var naturalHeight = scene.offsetHeight;
    stage.style.height = Math.ceil(naturalHeight * scale) + 'px';
  }

  // --- SVG connections: measured from real rendered layout, redrawn on resize. ---------------
  function bezierPoint(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
  }

  // Fixed, deterministic anchor angles (degrees, 0=east/right, positive=downward in SVG's
  // Y-down space) — spreads each side's 6 lines to a DIFFERENT point around Frost's own
  // circumference instead of every line on a side converging on the same edge point.
  var ANCHOR_ANGLES_DEG = [-55, -35, -15, 10, 30, 50];

  function renderConnections() {
    var svg = document.getElementById('ann-connections');
    var network = document.getElementById('ann-network');
    var core = document.getElementById('ann-frost-core');
    if (!svg || !network || !core) return;

    // getBoundingClientRect() returns POST-transform (visual) pixel coordinates, but this SVG
    // sits inside .ann-scene which is itself shrunk by transform:scale(). Setting the SVG's own
    // width/height/viewBox/path-d directly from those visual coordinates would get scaled DOWN
    // A SECOND TIME by the ancestor transform. Dividing by the current scale converts back to
    // the scene's natural (pre-transform) coordinate space, which is what the SVG actually lays
    // out in, so it lines up with the (also scaled-together) node elements at every scale.
    var scale = currentScale || 1;
    var rect = network.getBoundingClientRect();
    var rectWidth = rect.width / scale;
    var rectHeight = rect.height / scale;
    svg.setAttribute('width', rectWidth);
    svg.setAttribute('height', rectHeight);
    svg.setAttribute('viewBox', '0 0 ' + rectWidth + ' ' + rectHeight);

    var coreRect = core.getBoundingClientRect();
    var coreCenterX = (coreRect.left + coreRect.width / 2 - rect.left) / scale;
    var coreCenterY = (coreRect.top + coreRect.height / 2 - rect.top) / scale;
    var coreRadius = (coreRect.width / 2) / scale;
    var markup = '';
    var anchorMarkup = '';
    ['right', 'left'].forEach(function (side) {
      var nodes = network.querySelectorAll('.ann-side-' + side + ' .ann-node');
      nodes.forEach(function (node, sideIndex) {
        var agent = agentById(node.dataset.agentId);
        var color = (agent && agent.color) || '#b99aff';
        var nodeRect = node.getBoundingClientRect();
        var nodeX = ((side === 'right' ? nodeRect.left : nodeRect.right) - rect.left) / scale;
        var nodeY = (nodeRect.top + nodeRect.height / 2 - rect.top) / scale;

        var deg = ANCHOR_ANGLES_DEG[sideIndex % ANCHOR_ANGLES_DEG.length];
        var rad = deg * Math.PI / 180;
        var dx = coreRadius * Math.cos(rad) * (side === 'right' ? 1 : -1);
        var dy = coreRadius * Math.sin(rad);
        var anchorX = coreCenterX + dx;
        var anchorY = coreCenterY + dy;

        // Departs the card horizontally, then curves to enter its OWN distributed anchor
        // point tangentially (control point 2 pulled back toward the node horizontally,
        // rather than sitting exactly on the anchor) instead of one shared, sharply-hooked
        // midpoint — a smoother, less "bundled" curve per agent.
        var midX = (nodeX + anchorX) / 2;
        var tangentPullback = coreRadius * 0.6 * (side === 'right' ? -1 : 1);
        var ctrl2X = anchorX + tangentPullback;
        var pathId = 'ann-path-' + node.dataset.agentId;
        var d = 'M ' + nodeX + ' ' + nodeY + ' C ' + midX + ' ' + nodeY + ', ' + ctrl2X + ' ' + anchorY + ', ' + anchorX + ' ' + anchorY;
        markup += '<path id="' + pathId + '" class="ann-line" data-agent-id="' + node.dataset.agentId + '" d="' + d + '" stroke="' + color + '"/>';
        [0.35, 0.7].forEach(function (t) {
          var px = bezierPoint(nodeX, midX, ctrl2X, anchorX, t);
          var py = bezierPoint(nodeY, nodeY, anchorY, anchorY, t);
          markup += '<circle class="ann-line-node" data-agent-id="' + node.dataset.agentId + '" cx="' + px + '" cy="' + py + '" r="3.5" fill="' + color + '"/>';
        });
        // A small glowing node right on Frost's own perimeter at this agent's anchor point —
        // makes the distributed entry points visible and gives Frost a "receiving" pulse.
        anchorMarkup += '<circle class="ann-anchor-node" data-agent-id="' + node.dataset.agentId + '" cx="' + anchorX + '" cy="' + anchorY + '" r="3" fill="' + color + '"/>';
        // Traveling data particle — native SVG/SMIL animation (no JS animation loop), stopped
        // entirely under prefers-reduced-motion rather than left running invisibly. cx/cy are
        // set to the path's OWN start point (not left to default to 0,0) because a delayed
        // <animateMotion> (staggered up to 3.3s) leaves the circle at its base position until
        // it begins — without this, the highest-delay particle sat at the SVG's raw (0,0)
        // origin for its first few seconds, showing as a stray dot at the network's corner.
        if (!reduceMotion) {
          var delay = (sideIndex % 6) * 0.6 + (side === 'left' ? 0.3 : 0);
          markup += '<circle class="ann-line-particle" data-agent-id="' + node.dataset.agentId + '" cx="' + nodeX + '" cy="' + nodeY + '" r="3.5" fill="' + color + '" color="' + color + '">' +
            '<animateMotion dur="4.2s" begin="' + delay + 's" repeatCount="indefinite" rotate="auto">' +
            '<mpath href="#' + pathId + '"/></animateMotion>' +
            '</circle>';
        }
      });
    });
    svg.innerHTML = markup + anchorMarkup;
  }

  function setActiveConnection(agentId) {
    var svg = document.getElementById('ann-connections');
    if (!svg) return;
    svg.querySelectorAll('.ann-line, .ann-line-node, .ann-line-particle, .ann-anchor-node').forEach(function (el) {
      var isMatch = agentId && el.dataset.agentId === agentId;
      el.classList.toggle('is-active', !!isMatch);
      el.classList.toggle('is-dimmed', !!agentId && !isMatch);
    });
  }

  function attachHoverHandlers() {
    var network = document.getElementById('ann-network');
    if (!network) return;
    network.querySelectorAll('.ann-node').forEach(function (node) {
      node.addEventListener('mouseenter', function () { setActiveConnection(node.dataset.agentId); });
      node.addEventListener('mouseleave', function () { setActiveConnection(null); });
      node.addEventListener('focus', function () { setActiveConnection(node.dataset.agentId); });
      node.addEventListener('blur', function () { setActiveConnection(null); });
    });
  }

  // --- Details panel -----------------------------------------------------------------------
  var lastFocusedTrigger = null;

  function openPanel(agent, trigger) {
    var panel = document.getElementById('ann-panel');
    var backdrop = document.getElementById('ann-panel-backdrop');
    var title = document.getElementById('ann-panel-title');
    var icon = document.getElementById('ann-panel-icon');
    var body = document.getElementById('ann-panel-body');
    if (!panel || !backdrop || !title || !body) return;
    lastFocusedTrigger = trigger || null;

    title.textContent = agent.name;
    icon.innerHTML = svgIcon(agent.icon);
    icon.style.setProperty('--ann-color', agent.color || '#7c3aed');
    var html = '<p>' + escapeHtml(agent.description) + '</p>' +
      '<h4>متى يعمل</h4><p>' + escapeHtml(agent.when) + '</p>' +
      '<h4>الأدوات والصلاحيات</h4><ul>' + agent.tools.map(function (tool) { return '<li>' + escapeHtml(tool) + '</li>'; }).join('') + '</ul>' +
      '<h4>يستقبل المهام من</h4><ul>' + agent.receivesFrom.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ul>' +
      '<h4>يرسل النتيجة إلى</h4><ul>' + agent.sendsTo.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ul>';
    if (agent.requiresApproval) {
      html += '<div class="ann-panel-approval">يتطلب موافقة بشرية قبل تنفيذ أي إجراء خارجي (نشر أو إرسال فعلي).</div>';
    }
    body.innerHTML = html;

    backdrop.hidden = false;
    panel.hidden = false;
    document.getElementById('ann-panel-close').focus();
    document.addEventListener('keydown', onPanelKeydown);
  }

  function closePanel() {
    var panel = document.getElementById('ann-panel');
    var backdrop = document.getElementById('ann-panel-backdrop');
    if (!panel || !backdrop) return;
    panel.hidden = true;
    backdrop.hidden = true;
    document.removeEventListener('keydown', onPanelKeydown);
    if (lastFocusedTrigger) lastFocusedTrigger.focus();
  }

  function onPanelKeydown(event) {
    if (event.key === 'Escape') closePanel();
  }

  function attachClickHandlers() {
    var network = document.getElementById('ann-network');
    if (network) {
      network.querySelectorAll('.ann-node').forEach(function (node) {
        node.addEventListener('click', function () {
          var agent = agentById(node.dataset.agentId);
          if (agent) openPanel(agent, node);
        });
      });
    }
    var core = document.getElementById('ann-frost-core');
    if (core) core.addEventListener('click', function () { openPanel(FROST, core); });

    var closeBtn = document.getElementById('ann-panel-close');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    var backdrop = document.getElementById('ann-panel-backdrop');
    if (backdrop) backdrop.addEventListener('click', closePanel);
  }

  // --- Workflow timeline (circular icon steps) -------------------------------------------------
  // Built via DOM APIs + style.setProperty (CSSOM), never a `style="..."` attribute string —
  // that form IS blocked by this app's real CSP (style-src-attr), unlike direct CSSOM writes.
  function renderWorkflow() {
    var track = document.getElementById('ann-workflow-track');
    if (!track) return;
    track.innerHTML = '';
    WORKFLOW_STEPS.forEach(function (step, index) {
      var li = document.createElement('li');
      li.className = 'ann-workflow-step' + (step.approval ? ' is-approval' : '');

      if (step.approval) {
        var tag = document.createElement('span');
        tag.className = 'ann-workflow-tag';
        tag.textContent = 'مطلوب موافقة';
        li.appendChild(tag);
      }

      var icon = document.createElement('span');
      icon.className = 'ann-workflow-icon';
      icon.style.setProperty('--ann-color', step.color);
      icon.innerHTML = svgIcon(step.icon);
      li.appendChild(icon);

      var label = document.createElement('span');
      label.className = 'ann-workflow-label';
      label.textContent = step.label;
      li.appendChild(label);

      if (step.note) {
        var note = document.createElement('span');
        note.className = 'ann-workflow-note';
        note.textContent = step.note;
        li.appendChild(note);
      }

      track.appendChild(li);

      if (index < WORKFLOW_STEPS.length - 1) {
        var arrow = document.createElement('span');
        arrow.className = 'ann-workflow-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '←';
        var arrowLi = document.createElement('li');
        arrowLi.className = 'ann-workflow-connector';
        arrowLi.appendChild(arrow);
        track.appendChild(arrowLi);
      }
    });
  }

  // --- Live automation demo (scripted mock, replayable) ---------------------------------------
  // A compact breadcrumb of chips (Frost -> agent -> agent -> agent), not a second workflow —
  // it exists only to support the main workflow card above with one concrete, real example.
  var DEMO_ARROW = '<span class="ann-demo-chip-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></span>';
  function renderDemoSteps(activeIndex, doneUpTo) {
    var list = document.getElementById('ann-demo-steps');
    if (!list) return;
    list.innerHTML = DEMO_STEPS.map(function (step, index) {
      var state = index < doneUpTo ? 'done' : index === activeIndex ? 'active' : 'idle';
      var isLastWaiting = index === DEMO_STEPS.length - 1 && state === 'done';
      var statusText = isLastWaiting ? 'بانتظار الموافقة' : state === 'done' ? 'تم' : state === 'active' ? 'جارٍ الآن' : '';
      var cls = isLastWaiting ? 'is-waiting' : state === 'done' ? 'is-done' : state === 'active' ? 'is-active' : '';
      return '<li class="ann-demo-chip ' + cls + '" data-agent="' + step.id + '">' +
        '<span class="ann-demo-chip-icon" aria-hidden="true">' + svgIcon(step.id) + '</span>' +
        '<span class="ann-demo-chip-dot" aria-hidden="true"></span>' +
        '<strong>' + escapeHtml(step.label) + '</strong>' +
        (statusText ? '<span class="ann-demo-chip-status">' + statusText + '</span>' : '') + '</li>' +
        (index < DEMO_STEPS.length - 1 ? DEMO_ARROW : '');
    }).join('');
  }

  var demoTimer = null;
  function runDemo() {
    if (demoTimer) return; // already running
    var step = 0;
    renderDemoSteps(0, 0);
    setActiveConnection(DEMO_STEPS[0].id);
    var stepDelay = reduceMotion ? 0 : 900;
    demoTimer = setInterval(function () {
      step++;
      if (step >= DEMO_STEPS.length) {
        renderDemoSteps(-1, DEMO_STEPS.length);
        setActiveConnection(null);
        clearInterval(demoTimer);
        demoTimer = null;
        return;
      }
      renderDemoSteps(step, step);
      setActiveConnection(DEMO_STEPS[step].id);
    }, Math.max(stepDelay, 400));
  }

  // --- Header event example (single static illustrative card, see EVENT above) ----------------
  function renderEvent() {
    var iconEl = document.getElementById('ann-event-icon');
    var titleEl = document.getElementById('ann-event-title');
    var subEl = document.getElementById('ann-event-sub');
    if (!iconEl || !titleEl || !subEl) return;
    iconEl.innerHTML = svgIcon(EVENT.icon);
    iconEl.style.setProperty('--ann-color', EVENT.color);
    titleEl.textContent = EVENT.title;
    subEl.textContent = EVENT.sub;
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  function refreshScene() {
    initSceneScale();
    renderConnections();
  }

  function init() {
    renderNodes();
    attachHoverHandlers();
    attachClickHandlers();
    renderWorkflow();
    renderDemoSteps(-1, 0);
    renderEvent();
    // Scale must be computed AFTER the scene's real content (nodes + workflow) is rendered, so
    // offsetHeight reflects the true natural height, and connections use the right scale.
    refreshScene();

    var runBtn = document.getElementById('ann-demo-run');
    if (runBtn) runBtn.addEventListener('click', runDemo);

    window.addEventListener('resize', debounce(refreshScene, 150));
    window.addEventListener('orientationchange', refreshScene);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
