let chatPollTimer = null;

async function chatApi(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    if (response.ok) throw new Error('The server returned an invalid response.');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function dChat() {
  const mine = H.filter(community => community.id !== 'academy' && joined.has(community.id));
  if (!cc || !joined.has(cc)) cc = mine[0] ? mine[0].id : null;
  pg.innerHTML = head(
    'Community Chatroom',
    'Chat with peers from the same community. Sign in to send and view messages.'
  ) + (mine.length
    ? `<div class="tabs">${mine.map(community => `<button class="btn sm" style="${cc === community.id ? 'border-color:#7fa8ff' : ''}" data-a="chT" data-i="${community.id}">${esc(community.n)}</button>`).join('')}</div>
      <div class="pn" id="cl" style="height:min(50vh,420px);overflow:auto"></div>
      <div class="f" style="max-width:760px;margin-top:10px"><div class="row" style="margin:0">
      <input id="cm" maxlength="300" placeholder="Write a message" style="flex:1" aria-label="Message">
      <button class="btn pri sm" data-a="chS">Send</button></div><div class="err" id="er"></div></div>`
    : '<div class="pn"><p>You have not joined any community yet. Join one to open its chatroom.</p><button class="btn sm" data-a="chG">Go to Communities</button></div>');
  chSub();
}

function chSub() {
  if (typeof unsub === 'function') {
    unsub();
    unsub = null;
  }
  const list = document.getElementById('cl');
  if (!cc || !list) return;

  let active = true;
  const refresh = async () => {
    if (!active || cur !== 'chat') return;
    try {
      const data = await chatApi(`/api/chat/${encodeURIComponent(cc)}/messages`);
      const currentList = document.getElementById('cl');
      if (!active || cur !== 'chat' || !currentList) return;
      const messages = data.messages || [];
      currentList.innerHTML = messages.length
        ? messages.map(message => `<div class="chk" style="flex-direction:column;align-items:flex-start;gap:2px">
            <small class="mut">${esc(message.name || 'Member')}${message.isMe ? ' (you)' : ''} · ${new Date(message.createdAt).toLocaleTimeString([], { timeStyle: 'short' })}</small>
            <span>${esc(message.message)}</span></div>`).join('')
        : '<p class="mut">No messages yet. Say hi!</p>';
      currentList.scrollTop = currentList.scrollHeight;
    } catch (error) {
      const currentList = document.getElementById('cl');
      if (!active || !currentList) return;
      const signIn = error.message === 'Please sign in to continue.';
      currentList.innerHTML = `<p class="mut">${esc(signIn ? 'Sign in to view and send community messages.' : `Could not load chat: ${error.message}`)}</p>
        ${signIn ? '<button class="btn sm" type="button" data-chat-sign-in>Sign in</button>' : ''}`;
      const button = currentList.querySelector('[data-chat-sign-in]');
      if (button) button.addEventListener('click', () => document.getElementById('pl-account')?.click());
    }
    if (active) chatPollTimer = setTimeout(refresh, 5000);
  };

  unsub = () => {
    active = false;
    clearTimeout(chatPollTimer);
  };
  void refresh();
}

async function chatSend() {
  const input = document.getElementById('cm');
  const message = input?.value.trim();
  if (!message) return err('Type a message first.');
  if (!cc || !joined.has(cc)) return err('Join this community to chat.');
  if (Date.now() - lastSend < 1000) return err('Slow down a little.');
  lastSend = Date.now();

  try {
    await chatApi(`/api/chat/${encodeURIComponent(cc)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message })
    });
    input.value = '';
    err('');
    chSub();
  } catch (error) {
    err(error.message);
    if (error.message === 'Please sign in to continue.') {
      document.getElementById('pl-account')?.click();
    }
  }
}
