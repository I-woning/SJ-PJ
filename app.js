const socket = io();

// UI 단계 래퍼
const stepNickname = document.getElementById('step-nickname');
const stepChapter = document.getElementById('step-chapter');
const stepWaiting = document.getElementById('step-waiting');

// DOM 요소 (구역 구분 뷰)
const lobbyView = document.getElementById('lobby-view');
const ingameView = document.getElementById('ingame-view');
const stepRoomChoice = document.getElementById('step-room-choice');
const roomListEl = document.getElementById('active-room-list');

// DOM 요소 (로비/대기실 폼)
const playerNameInput = document.getElementById('player-name');
const btnSubmitName = document.getElementById('btn-submit-name');
const btnSelectCh1 = document.getElementById('btn-select-ch1');
const startBtn = document.getElementById('start-btn');
const lobbyPlayerList = document.getElementById('lobby-player-list');

// DOM 요소 (게임)
const logEl = document.getElementById('game-log');
const inputEl = document.getElementById('command-input');
const sendBtn = document.getElementById('send-btn');
const turnIndicator = document.getElementById('turn-indicator');
const locationBadge = document.getElementById('location-badge');
const partyListEl = document.getElementById('party-list');
const enemyListEl = document.getElementById('enemy-list');

// DOM 요소 (채팅)
const chatLogEl = document.getElementById('chat-log');
const chatInputEl = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatUserListEl = document.getElementById('chat-user-list');
const chatUserCountEl = document.getElementById('chat-user-count');

let myPlayerInfo = null;

// [STEP 1: 닉네임 입력]
btnSubmitName.addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  if (!name) return alert('닉네임을 입력하세요!');

  socket.emit('join_server', { name });
  myPlayerInfo = { name };

  stepNickname.style.display = 'none';
  stepRoomChoice.style.display = 'block';
});

// [STEP 1.5: 방 생성 / 참가]
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const roomIdInput = document.getElementById('room-id-input');

btnCreateRoom.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim(); // 없으면 서버에서 자동 생성
  socket.emit('create_room', roomId);
});

btnJoinRoom.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim();
  if (!roomId) return alert('참가할 방 ID를 입력하세요!');
  socket.emit('join_room', roomId);
});

socket.on('room_list', (rooms) => {
  if (!roomListEl) return;
  if (rooms.length === 0) {
    roomListEl.innerHTML = '<li>현재 활성화된 방이 없습니다.</li>';
  } else {
    roomListEl.innerHTML = rooms.map(r =>
      `<li style="margin-bottom:5px; cursor:pointer; color:#eee;" onclick="document.getElementById('room-id-input').value='${r.id}'">
        <strong>[${r.id}]</strong> - ${r.playerCount}명 대기 중 (${r.phase})
      </li>`
    ).join('');
  }
});

socket.on('room_joined', (roomId) => {
  stepRoomChoice.style.display = 'none';
  stepChapter.style.display = 'block';
});

socket.on('join_error', (msg) => {
  alert(msg);
});

// [STEP 2: 챕터 선택]
btnSelectCh1.addEventListener('click', () => {
  socket.emit('select_chapter', 'ch1');
});

socket.on('chapter_selected', (ch) => {
  // 방에 입장 (여기서는 기본 글로벌 룸 처리)
  stepChapter.style.display = 'none';
  stepWaiting.style.display = 'block';
});

// [STEP 3: 대기실 및 시작]
startBtn.addEventListener('click', () => {
  socket.emit('start_game');
});

socket.on('lobby_update', (clients, isStarted) => {
  // 로비 뷰 리스트 (수직 구조)
  lobbyPlayerList.innerHTML = clients.map(c =>
    `<li><strong>${c.nickname}</strong> ${c.socketId === socket.id ? '(나)' : ''}</li>`
  ).join('');

  // 우측 채팅 뷰 리스트 (태그 구조) 및 인원 수
  if (chatUserCountEl) chatUserCountEl.innerText = `${clients.length}명`;
  if (chatUserListEl) {
    chatUserListEl.innerHTML = clients.map(c =>
      `<li>${c.nickname}</li>`
    ).join('');
  }

  if (clients.length > 0) startBtn.disabled = false;
  if (isStarted) startBtn.disabled = true;
});

socket.on('game_error', (msg) => {
  const el = document.createElement('div');
  el.className = 'log-entry system-msg log-fade-in';
  el.innerHTML = `⚠️ <span style="color:#ff4a4a; font-weight:bold;">[입력 오류]</span> ${msg}`;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
});

// [채팅 로직]
function sendChat() {
  const txt = chatInputEl.value.trim();
  if (!txt) return;
  socket.emit('chat_message', txt);
  chatInputEl.value = '';
  chatInputEl.focus();
}

chatSendBtn.addEventListener('click', sendChat);
chatInputEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChat();
});

socket.on('chat_message', ({ sender, msg, type }) => {
  const el = document.createElement('div');
  if (type === 'system') {
    el.className = 'chat-msg system';
    el.innerText = msg;
  } else {
    el.className = 'chat-msg';
    el.innerHTML = `<span class="chat-sender">[${sender}]</span>${msg}`;
  }
  chatLogEl.appendChild(el);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
});

// [디버그 컨트롤 로직]
const btnSkipHallway = document.getElementById('btn-skip-hallway');
const btnSkipKitchen = document.getElementById('btn-skip-kitchen');
const btnSkip2F = document.getElementById('btn-skip-2f');
const btnSkipRoom2fWait = document.getElementById('btn-skip-room2f-wait');
const btnLobbyReset = document.getElementById('btn-lobby-reset');

if (btnSkipHallway) btnSkipHallway.addEventListener('click', () => socket.emit('debug_skip', 'hallway'));
if (btnSkipKitchen) btnSkipKitchen.addEventListener('click', () => socket.emit('debug_skip', 'kitchen'));
if (btnSkip2F) btnSkip2F.addEventListener('click', () => socket.emit('debug_skip', '2f'));
if (btnSkipRoom2fWait) btnSkipRoom2fWait.addEventListener('click', () => socket.emit('debug_skip', 'room2f_wait'));

const btnSkipShrine = document.getElementById('btn-skip-shrine');
if (btnSkipShrine) btnSkipShrine.addEventListener('click', () => socket.emit('debug_skip', 'shrine'));

if (btnLobbyReset) {
  btnLobbyReset.addEventListener('click', () => {
    if (confirm('방의 모든 진행 상태를 초기화하고 로비로 돌아가시겠습니까?')) {
      socket.emit('reset_game_to_lobby');
    }
  });
}

socket.on('force_lobby', () => {
  location.reload(); // 가장 확실한 초기화 방법
});


// [게임 렌더링 로직]
socket.on('game_started', () => {
  lobbyView.style.display = 'none';
  ingameView.style.display = 'flex';
});

socket.on('location_update', (loc) => {
  locationBadge.innerText = `현재 위치: ${loc}`;
});

socket.on('state_update', (party, enemies, turnOwner, phase) => {
  partyListEl.innerHTML = party.map(p => `
    <div class="character-card ${p.engJob} ${turnOwner && turnOwner.id === p.id ? 'active-turn' : ''}" id="card-${p.id}">
      <div class="char-header">
        <span class="char-name">${p.name} <span class="char-job">[${p.job}]</span></span>
      </div>
      <div class="stat-row">
        <span class="stat-label">HP</span>
        <div class="stat-bar-bg"><div class="stat-bar-fill hp" style="width: ${(p.hp / p.maxHp) * 100}%"></div></div>
        <span class="stat-value">${p.hp}/${p.maxHp}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">MP</span>
        <div class="stat-bar-bg"><div class="stat-bar-fill mp" style="width: ${(p.mp / p.maxMp) * 100}%"></div></div>
        <span class="stat-value">${p.mp}/${p.maxMp}</span>
      </div>
      ${p.status.length > 0 ? `<div class="status-effects">${p.status.map(s => `<span class="status-badge">${s}</span>`).join('')}</div>` : ''}
    </div>
  `).join('');

  if (enemies.length === 0) {
    if (phase === 'STORY_ENTRANCE') {
      enemyListEl.innerHTML = `<div class="enemy-card"><div class="enemy-name" style="color:var(--text-dim);">[대기] 안쪽에서 기분나쁜 소리가 들립니다...</div></div>`;
    } else {
      enemyListEl.innerHTML = `<div class="enemy-card"><div class="enemy-name" style="color:var(--system-msg);">주위에 적이 없습니다.</div></div>`;
    }
  } else {
    enemyListEl.innerHTML = enemies.filter(e => e.hp > 0).map(e => `
      <div class="enemy-card">
        <div class="enemy-name">${e.name} ${e.status && e.status.includes('은신') ? '<span style="color:#ff6b6b; font-size:0.75rem;">(투명/탐색필요)</span>' : ''}</div>
        <div class="stat-row">
          <span class="stat-label">HP</span>
          <div class="stat-bar-bg"><div class="stat-bar-fill hp" style="width: ${(e.hp / e.maxHp) * 100}%"></div></div>
          <span class="stat-value">${e.hp}/${e.maxHp}</span>
        </div>
      </div>
    `).join('');
  }

  if (turnOwner) {
    const isPartyTurn = party.some(p => p.id === turnOwner.id);
    if (isPartyTurn) {
      turnIndicator.innerText = `[${turnOwner.name}] 턴 대기 중...`;
    } else {
      turnIndicator.innerText = `...`;
    }
  } else {
    if (phase === 'STORY_ENTRANCE') {
      turnIndicator.innerText = `스토리 씬 진행 중`;
    } else {
      turnIndicator.innerText = `상호작용 대기 중`;
    }
  }
});

socket.on('action_result', ({ msg, className }) => {
  const el = document.createElement('div');
  el.className = `log-entry log-fade-in ${className}`;
  el.innerHTML = msg;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
});

// [글로벌 다중 컨트롤 입력 처리]
// 스토리 모드 입력 대기
socket.on('story_input_start', (placeholder) => {
  inputEl.disabled = false;
  sendBtn.disabled = false;
  inputEl.placeholder = placeholder || "명령을 입력하세요...";

  // 통신 채팅 중(메시지 입력 중)이면 게임 입력창으로 포커스를 뺏지 않음
  if (document.activeElement !== chatInputEl) {
    inputEl.focus();
  }
});

// 전투 모드 입력 대기
socket.on('turn_start', (turnOwner, serverPlaceholder) => {
  inputEl.disabled = false;
  sendBtn.disabled = false;

  if (document.activeElement !== chatInputEl) {
    inputEl.focus();
  }

  if (serverPlaceholder) {
    inputEl.placeholder = serverPlaceholder;
  } else if (turnOwner) {
    const SKILL_HINTS = {
      '무당': '스킬 징치기',
      '퇴마사': '스킬 사인검베기 [적/아군]',
      '영매': '스킬 혼령묶기 [적/아군]',
      '사제': '스킬 성수뿌리기 [아군/적]'
    };
    const hint = SKILL_HINTS[turnOwner.job] || '';
    inputEl.placeholder = `▶ [${turnOwner.name} 행동] 공격 [적], 방어, ${hint}`;
  }
});

socket.on('turn_wait', () => {
  inputEl.disabled = true;
  sendBtn.disabled = true;
  inputEl.placeholder = "결과 처리 중... (명령 대기)";
});

function handleCommandSend() {
  const txt = inputEl.value;
  if (!txt) return;

  socket.emit('user_input', txt);
  inputEl.value = '';
}

socket.on('darken_ui', () => {
  const overlay = document.getElementById('dark-overlay');
  if (overlay) {
    overlay.style.display = 'block';
    setTimeout(() => { overlay.style.opacity = '1'; }, 50);
  }
});

socket.on('restore_ui', () => {
  const overlay = document.getElementById('dark-overlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 2000);
  }
});

sendBtn.addEventListener('click', handleCommandSend);
inputEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleCommandSend();
});
