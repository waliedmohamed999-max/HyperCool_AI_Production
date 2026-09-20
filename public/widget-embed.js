// HyperCool Website AI Chat Widget — public embed script (Phase MKT-1, spec Part 86-87).
// Self-contained vanilla JS, zero dependencies, injects its own minimal styles (this runs on
// an arbitrary third-party page, so it cannot assume any of HyperCool's own stylesheet).
// Carries no secret: the only configuration is the public, non-secret widget id.
//
// Usage on a tenant's own website:
//   <script src="https://<your-hypercool-host>/widget-embed.js" data-widget-id="PUBLIC_ID" async></script>
(function () {
  var currentScript = document.currentScript;
  if (!currentScript) return;
  var widgetId = currentScript.getAttribute('data-widget-id');
  if (!widgetId) { console.warn('[Frost Widget] missing data-widget-id attribute'); return; }
  var origin = new URL(currentScript.src).origin;
  var leadId = null;
  try { leadId = sessionStorage.getItem('hc_widget_lead_' + widgetId) || null; } catch (e) {}

  var style = document.createElement('style');
  style.textContent = '\
    .hc-widget-bubble{position:fixed;inset-inline-end:20px;inset-block-end:20px;width:56px;height:56px;border-radius:50%;background:#635BFF;color:#fff;border:0;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.2);font-size:24px;z-index:2147483000}\
    .hc-widget-panel{position:fixed;inset-inline-end:20px;inset-block-end:86px;width:320px;max-width:calc(100vw - 32px);height:440px;max-height:70vh;background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif;z-index:2147483000}\
    .hc-widget-panel.open{display:flex}\
    .hc-widget-head{background:#635BFF;color:#fff;padding:14px 16px;font-size:14px;font-weight:600}\
    .hc-widget-messages{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#F4F7FB}\
    .hc-widget-msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5}\
    .hc-widget-msg.user{align-self:flex-end;background:#635BFF;color:#fff}\
    .hc-widget-msg.bot{align-self:flex-start;background:#fff;border:1px solid #e0e6eb;color:#1F2A3D}\
    .hc-widget-form{display:flex;gap:6px;padding:10px;border-top:1px solid #e0e6eb;background:#fff}\
    .hc-widget-form input{flex:1;border:1px solid #e0e6eb;border-radius:8px;padding:8px 10px;font-size:13px}\
    .hc-widget-form button{border:0;background:#635BFF;color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}\
  ';
  document.head.appendChild(style);

  var bubble = document.createElement('button');
  bubble.className = 'hc-widget-bubble';
  bubble.setAttribute('aria-label', 'Chat');
  bubble.textContent = '💬';

  var panel = document.createElement('div');
  panel.className = 'hc-widget-panel';
  panel.innerHTML =
    '<div class="hc-widget-head">Frost Assistant</div>' +
    '<div class="hc-widget-messages"></div>' +
    '<form class="hc-widget-form">' +
      '<input type="text" name="text" placeholder="Type a message..." maxlength="2000" required>' +
      '<button type="submit">Send</button>' +
    '</form>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var messagesEl = panel.querySelector('.hc-widget-messages');
  var formEl = panel.querySelector('form');
  var inputEl = panel.querySelector('input');
  var greeted = false;

  function addMessage(text, who) {
    var div = document.createElement('div');
    div.className = 'hc-widget-msg ' + who;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  bubble.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && !greeted) {
      greeted = true;
      addMessage('Hi! How can we help you today?', 'bot');
    }
  });

  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    inputEl.value = '';
    inputEl.disabled = true;
    fetch(origin + '/api/public/widget/' + encodeURIComponent(widgetId) + '/chat', {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, leadId: leadId })
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        inputEl.disabled = false;
        inputEl.focus();
        if (!result.ok) { addMessage('Sorry, this chat is currently unavailable.', 'bot'); return; }
        if (result.data.leadId) {
          leadId = result.data.leadId;
          try { sessionStorage.setItem('hc_widget_lead_' + widgetId, leadId); } catch (e) {}
        }
        if (result.data.reply) addMessage(result.data.reply, 'bot');
        else addMessage('Thanks for your message — our team will get back to you soon.', 'bot');
      })
      .catch(function () {
        inputEl.disabled = false;
        addMessage('Network error — please try again.', 'bot');
      });
  });
})();
