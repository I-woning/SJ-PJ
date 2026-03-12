const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const chapters = require('./chapters');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,    // 60초 (기본 20초) - 브라우저 과부하 시에도 연결 유지
    pingInterval: 30000    // 30초 (기본 25초)
});

app.use(express.static('public'));

// 4개의 고정 파티 유닛 데이터 (스킬 정보 추가)
const STARTING_PARTY = [
    {
        id: 'p1', name: '천화', job: '무당', hp: 120, maxHp: 120, mp: 60, maxMp: 60, status: [], engJob: 'job-무당',
        skillInfo: "[징치기] (MP 10): 자신 방어력 대폭 상승 및 어그로 자신에게 집중"
    },
    {
        id: 'p2', name: '강림', job: '퇴마사', hp: 100, maxHp: 100, mp: 50, maxMp: 50, status: [], engJob: 'job-퇴마사',
        skillInfo: "[사인검베기] (MP 15): 단일 적에게 치명적인 물리/영적 큰 데미지"
    },
    {
        id: 'p3', name: '연화', job: '영매', hp: 80, maxHp: 80, mp: 90, maxMp: 90, status: [], engJob: 'job-영매',
        skillInfo: "[혼령묶기] (MP 20): 대상 적군 1명 1턴 간 완전히 행동불가(스턴)"
    },
    {
        id: 'p4', name: '요한', job: '사제', hp: 90, maxHp: 90, mp: 100, maxMp: 100, status: [], engJob: 'job-사제',
        skillInfo: "[성수뿌리기] (MP 15): 아군 1명 체력 즉시 +30 회복 및 상태이상 정화"
    }
];

// 방(Room) 관리 객체
const rooms = {};

// 게임 상태 초기화 팩토리 함수
function createInitialGameState() {
    return {
        isStarted: false,
        phase: 'LOBBY',
        activeChapterId: 'chapter1', // 현재 활성화된 챕터 ID
        globalFlags: {},             // 챕터 간 공유 정보 (세계관 유지용)
        clients: [],                 // { socketId, nickname }
        party: JSON.parse(JSON.stringify(STARTING_PARTY)),
        enemies: [],
        turnQueue: [],
        currentTurnIndex: 0,
        isWaitingForInput: false,
        location: '알 수 없음',
        waitCount: 0,
        turnOwner: null
    };
}

// [유틸] Fisher-Yates 셔플 (정확한 균등 분배)
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

const SAVE_FILE = path.join(__dirname, 'server_state.json');

// [세이브] 서버 상태를 파일에 기록
function saveServerState() {
    try {
        const data = JSON.stringify(rooms);
        fs.writeFileSync(SAVE_FILE, data, 'utf8');
    } catch (e) {
        console.error('[서버 세이브 에러]', e);
    }
}

// [로드] 서버 시작 시 파일에서 상태 복구
function loadServerState() {
    try {
        if (fs.existsSync(SAVE_FILE)) {
            const data = fs.readFileSync(SAVE_FILE, 'utf8');
            const savedRooms = JSON.parse(data);
            // 복구된 방들에 대해 타이머 등 비직렬화된 데이터 초기화
            for (const id in savedRooms) {
                savedRooms[id]._watchdogTimer = null;
                rooms[id] = savedRooms[id];
            }
            console.log(`[서버 로드 완료] ${Object.keys(rooms).length}개의 방 복구됨.`);
        }
    } catch (e) {
        console.error('[서버 로드 에러]', e);
    }
}

// 서버 시작 시 로드 실행
loadServerState();

// 방 목록 동기화 헬퍼
function broadcastRoomList() {
    const list = Object.keys(rooms).map(id => ({
        id: id,
        playerCount: rooms[id].clients.length,
        phase: rooms[id].phase
    }));
    io.emit('room_list', list);
}

// 특정 소켓의 방 찾기
function getSocketRoom(socket) {
    for (const roomId in rooms) {
        if (rooms[roomId].clients.some(c => c.socketId === socket.id)) {
            return { roomId, gameState: rooms[roomId] };
        }
    }
    return null;
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    broadcastRoomList();

    // 1. 서버 접속 (닉네임만 설정)
    socket.on('join_server', ({ name }) => {
        socket.nickname = name;
        console.log(`Nickname set: ${socket.id} -> ${name}`);
        broadcastRoomList();
    });

    // [세션 복원] 새로고침/재접속 시 기존 방에 자동 복귀
    socket.on('rejoin_room', ({ nickname, roomId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('rejoin_failed');
            return;
        }
        socket.nickname = nickname;

        // 기존 클라이언트 항목의 socketId를 새 소켓으로 교체
        const existingClient = room.clients.find(c => c.nickname === nickname);
        if (existingClient) {
            existingClient.socketId = socket.id;
        } else {
            room.clients.push({ socketId: socket.id, nickname: nickname });
        }

        socket.join(roomId);
        console.log(`[세션복원] ${nickname} -> room ${roomId} (phase: ${room.phase})`);

        // 게임 상태 일괄 재전송
        if (room.isStarted) {
            socket.emit('game_started');
            socket.emit('location_update', room.location);
            socket.emit('state_update', room.party, room.enemies, room.turnOwner, room.phase);

            if (room.isWaitingForInput) {
                if (room.phase === 'COMBAT' || room.phase === 'INCANTATION') {
                    socket.emit('turn_start', room.turnOwner, room.lastPlaceholder);
                } else {
                    const prompts = {
                        'STORY_ENTRANCE': "▶ '진입' 이라고 명령하십시오.",
                        'STORY_HALLWAY': "▶ '전투 준비' 라고 명령하십시오.",
                        'STORY_KITCHEN_WAIT': "▶ '전투 준비' 라고 명령하십시오.",
                        'STORY_KITCHEN_FIND': "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.",
                        'STORY_2F_HALLWAY': "▶ '이동 안방', '대기', '탐색' 중 선택하십시오.",
                        'STORY_AFTER_COMBAT': "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.",
                        'STORY_AFTER_KITCHEN': "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.",
                        'STORY_AFTER_ROOM2F': "▶ '이동', '둘러보기', '탐색 [대상]', '개인정비' 중 선택하십시오.",
                        'STORY_AFTER_BASEMENT_ENTRANCE': "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.",
                        'STORY_BASEMENT_CORE_ENTRY': "▶ '문자를 확인한다' 라고 입력하십시오.",
                    };
                    socket.emit('story_input_start', room.lastPlaceholder || prompts[room.phase] || "진행 중입니다. 명령을 입력하세요.");
                }
            } else {
                socket.emit('turn_wait');
            }
            socket.emit('rejoin_success', { roomId });
        } else {
            // 게임 시작 전이면 로비로
            socket.emit('room_joined', roomId);
            io.to(roomId).emit('lobby_update', room.clients, room.isStarted);
            socket.emit('rejoin_success', { roomId });
        }
    });

    // 2. 방 생성
    socket.on('create_room', (reqId) => {
        const roomId = reqId || Math.random().toString(36).substring(2, 7).toUpperCase();
        if (rooms[roomId]) return socket.emit('join_error', '이미 존재하는 방 ID입니다.');

        rooms[roomId] = createInitialGameState();
        rooms[roomId].clients.push({ socketId: socket.id, nickname: socket.nickname || '익명' });

        socket.join(roomId);
        socket.emit('room_joined', roomId);
        io.to(roomId).emit('chat_message', { sender: 'SYSTEM', msg: `[${socket.nickname}] 님이 오컬트 작전본부를 세웠습니다. (방 ID: ${roomId})`, type: 'system' });
        io.to(roomId).emit('lobby_update', rooms[roomId].clients, rooms[roomId].isStarted);
        broadcastRoomList();
    });

    // 3. 방 참가 (난입 포함)
    socket.on('join_room', (roomId) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('join_error', '존재하지 않는 방입니다.');

        const existing = room.clients.find(c => c.socketId === socket.id);
        if (!existing) {
            room.clients.push({ socketId: socket.id, nickname: socket.nickname || '익명' });
        }

        socket.join(roomId);
        socket.emit('room_joined', roomId);
        io.to(roomId).emit('chat_message', { sender: 'SYSTEM', msg: `[${socket.nickname}] 님이 작전에 합류했습니다.`, type: 'system' });
        io.to(roomId).emit('lobby_update', room.clients, room.isStarted);
        broadcastRoomList();

        // 난입 시 상태 동기화
        if (room.isStarted) {
            socket.emit('game_started');
            socket.emit('location_update', room.location);
            socket.emit('state_update', room.party, room.enemies, room.turnOwner, room.phase);
            if (room.isWaitingForInput) {
                if (room.phase === 'COMBAT') {
                    socket.emit('turn_start', room.turnOwner);
                } else {
                    syncInputState(roomId);
                }
            }
        }
    });

    socket.on('select_chapter', (chId) => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo) return;
        roomInfo.gameState.activeChapterId = chId; 
        socket.emit('chapter_selected', chId);
        io.to(roomInfo.roomId).emit('lobby_update', roomInfo.gameState.clients, roomInfo.gameState.isStarted);
    });

    socket.on('start_game', () => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo || roomInfo.gameState.isStarted) return;
        const { roomId, gameState } = roomInfo;

        const chapter = chapters.get(gameState.activeChapterId);
        if (!chapter) return socket.emit('game_error', '유효하지 않은 챕터입니다.');

        // 챕터별 초기 상태 병합
        const chapterInitialState = chapter.getInitialState();
        Object.assign(gameState, chapterInitialState);

        gameState.isStarted = true;
        
        io.to(roomId).emit('game_started');
        io.to(roomId).emit('location_update', gameState.location);
        io.to(roomId).emit('lobby_update', gameState.clients, gameState.isStarted);
        broadcastRoomList();

        // 챕터별 인트로 실행
        chapter.startIntro(io, roomId, gameState);
        
        saveServerState();
    });

    socket.on('chat_message', (msg) => {
        const roomInfo = getSocketRoom(socket);
        const senderName = socket.nickname || '익명';
        if (roomInfo) {
            io.to(roomInfo.roomId).emit('chat_message', { sender: senderName, msg: msg, type: 'user' });
        }
    });

    socket.on('user_input', (txt) => {
        try {
            const roomInfo = getSocketRoom(socket);
            if (!roomInfo || !roomInfo.gameState.isStarted) return;
            const { roomId, gameState } = roomInfo;
            const nickname = socket.nickname || '익명';
            const trimmed = txt.trim();
            if (trimmed === '') return;

            const helpers = {
                io, broadcastRoomLog, broadcastRoomState, syncInputState,
                startCombatCycle, startIncantationTurn, startEnding,
                parseCommand, executePlayerAction, nextTurn, safeNextTurn,
                resetToLobby: (rId) => {
                    const gs = rooms[rId];
                    if (!gs) return;
                    const clientsSnapshot = gs.clients;
                    rooms[rId] = createInitialGameState();
                    rooms[rId].clients = clientsSnapshot;
                    io.to(rId).emit('force_lobby');
                    broadcastRoomList();
                }
            };

            const chapter = chapters.get(gameState.activeChapterId);
            const handled = chapter.handleInput(socket, roomId, gameState, nickname, trimmed, helpers);

            if (handled) {
                saveServerState();
                return;
            }

            if (gameState.isWaitingForInput) {
                syncInputState(roomId);
            }
        } catch (e) {
            console.error('[user_input 에러]', e);
            const roomInfo = getSocketRoom(socket);
            if (roomInfo && roomInfo.gameState) {
                roomInfo.gameState.isWaitingForInput = true;
                syncInputState(roomInfo.roomId, "⚠️ 오류가 발생했습니다. 다시 시도하십시오.");
            }
        }
        saveServerState();
    });

    socket.on('debug_skip', (target) => {
        try {
            const roomInfo = getSocketRoom(socket);
            if (!roomInfo) return;
            const { roomId, gameState } = roomInfo;

            if (!gameState.isStarted) {
                gameState.isStarted = true;
                io.to(roomId).emit('game_started');
                io.to(roomId).emit('lobby_update', gameState.clients, gameState.isStarted);
                broadcastRoomList();
            }

            const helpers = { broadcastRoomLog, broadcastRoomState, syncInputState };
            const chapter = chapters.get(gameState.activeChapterId);
            const handled = chapter.handleDebugSkip(io, roomId, gameState, target, helpers);
            
            if (!handled) {
                socket.emit('game_error', '해당 챕터에서 지원하지 않는 스킵 지점입니다.');
            }
        } catch (e) {
            console.error('[debug_skip 에러]', e);
            socket.emit('game_error', '스킵 처리 중 오류가 발생했습니다.');
        }
        saveServerState();
    });

    socket.on('get_save_code', () => {
        try {
            const roomInfo = getSocketRoom(socket);
            if (!roomInfo || !roomInfo.gameState) {
                socket.emit('game_error', '저장할 게임 상태가 없습니다.');
                return;
            }
            const { gameState } = roomInfo;
            const saveStateString = JSON.stringify(gameState);
            const saveCode = Buffer.from(saveStateString).toString('base64');
            socket.emit('save_code_generated', saveCode);
            broadcastRoomLog(roomInfo.roomId, "💾 게임 저장 코드가 생성되었습니다.", "system-msg");
        } catch (e) {
            console.error('[get_save_code 에러]', e);
            socket.emit('game_error', '저장 코드 생성 중 오류가 발생했습니다.');
        }
    });

    socket.on('load_save_code', (saveCode) => {
        try {
            const roomInfo = getSocketRoom(socket);
            if (!roomInfo) return;
            const { roomId } = roomInfo;
            const decodedStateString = Buffer.from(saveCode, 'base64').toString('utf8');
            const loadedGameState = JSON.parse(decodedStateString);

            const currentClients = rooms[roomId].clients;
            rooms[roomId] = loadedGameState;
            rooms[roomId].clients = currentClients;
            rooms[roomId].roomId = roomId;

            const gameState = rooms[roomId];

            io.to(roomId).emit('save_code_loaded');
            io.to(roomId).emit('game_started');
            io.to(roomId).emit('lobby_update', gameState.clients, gameState.isStarted);
            io.to(roomId).emit('location_update', gameState.location);
            broadcastRoomLog(roomId, "✅ 게임이 성공적으로 로드되었습니다.", "system-msg");
            broadcastRoomState(roomId);
            syncInputState(roomId);

            saveServerState();
        } catch (e) {
            console.error('[load_save_code 에러]', e);
            socket.emit('game_error', '저장 코드 로드 중 오류가 발생했습니다.');
        }
    });

    socket.on('reset_game_to_lobby', () => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo) return;
        const { roomId, gameState } = roomInfo;
        const clients = gameState.clients;
        rooms[roomId] = createInitialGameState();
        rooms[roomId].clients = clients;
        io.to(roomId).emit('force_lobby');
        broadcastRoomList();
    });

    socket.on('disconnect', () => {
        const roomInfo = getSocketRoom(socket);
        if (roomInfo) {
            const { roomId, gameState } = roomInfo;
            const idx = gameState.clients.findIndex(c => c.socketId === socket.id);
            if (idx !== -1) {
                gameState.clients.splice(idx, 1);
                if (gameState.clients.length === 0) delete rooms[roomId];
                else io.to(roomId).emit('lobby_update', gameState.clients, gameState.isStarted);
                broadcastRoomList();
            }
        }
    });
});

// [핵심] 서버-클라이언트 입력 상태 강제 동기화 시스템
function syncInputState(roomId, customPlaceholder = null) {
    const gs = rooms[roomId];
    if (!gs) return;

    if (customPlaceholder) gs.lastPlaceholder = customPlaceholder;

    if (gs.isWaitingForInput) {
        if (gs.phase === 'COMBAT') {
            const currentActor = gs.turnOwner;
            if (currentActor) {
                const SKILL_HINTS = {
                    '무당': '스킬 징치기',
                    '퇴마사': '스킬 사인검베기 [적/아군]',
                    '영매': '스킬 혼령묶기 [적/아군]',
                    '사제': '스킬 성수뿌리기 [아군/적]'
                };
                const hint = SKILL_HINTS[currentActor.job] || '';
                const placeholder = gs.lastPlaceholder || `▶ [${currentActor.name} 행동] 공격 [적], 방어, ${hint}`;
                io.to(roomId).emit('turn_start', currentActor, placeholder);
                return;
            }
        }
        
        // 챕터별 커스텀 플레이스홀더 요청
        const chapter = chapters.get(gs.activeChapterId);
        const chapterPlaceholder = chapter.getPlaceholder(gs);
        
        if (chapterPlaceholder) {
            io.to(roomId).emit('story_input_start', chapterPlaceholder);
        } else {
            // 엔진 기본 공통 처리
            if (gs.phase === 'INCANTATION') {
                io.to(roomId).emit('turn_start', gs.turnOwner, gs.lastPlaceholder || `▶ [영창] 담당 글자를 입력하세요.`);
            } else {
                const defaultPlaceholder = gs.lastPlaceholder || "▶ 명령을 입력하세요.";
                io.to(roomId).emit('story_input_start', defaultPlaceholder);
            }
        }
    } else {
        io.to(roomId).emit('turn_wait');
    }
}

// Broadcast 헬퍼
function broadcastRoomState(roomId) {
    const room = rooms[roomId];
    if (room) {
        io.to(roomId).emit('state_update', room.party, room.enemies, room.turnOwner, room.phase);
        // [최적화] syncInputState 자동 호출 제거 - 필요한 시점에서만 명시적 호출
    }
}

function broadcastRoomLog(roomId, msg, className = "action-msg") {
    let finalMsg = msg;
    const gs = rooms[roomId];
    if (gs && gs.location === '2층 안방' && gs.isMirrorGlitchActive) {
        // 요한(사제)의 턴에는 성스러운 기운으로 왜곡을 보지 않음
        if (gs.turnOwner && gs.turnOwner.job === '사제') {
            // 왜곡 스킵
        } else {
            const glitches = ['†', '‡', '§', '¶', '¿', 'Ø', 'Þ', 'þ'];
            // HTML 태그와 엔티티를 보호하면서 텍스트 부분만 왜곡
            finalMsg = msg.replace(/(<[^>]+>|&[^;]+;|[^<>&]+)/g, (match) => {
                if (match.startsWith('<') || match.startsWith('&')) return match;
                return match.split('').map(c => (Math.random() < 0.1 && c !== ' ') ? glitches[Math.floor(Math.random() * glitches.length)] : c).join('');
            });
        }
    }
    io.to(roomId).emit('action_result', { msg: finalMsg, className });
}

// 전투 엔진
function startCombatCycle(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.turnQueue = [...room.party.filter(p => p.hp > 0), ...room.enemies.filter(e => e.hp > 0)];
    room.currentTurnIndex = 0;
    nextTurn(roomId);
}

function startIncantationTurn(roomId) {
    const gs = rooms[roomId];
    if (!gs) return;
    // 영창 모드에서는 4명 모두의 턴을 순차적으로(하지만 섞인 순서로) 진행
    // [버그수정] 균등 셔플(Fisher-Yates)을 사용하여 4명이 한 번씩 공평하게 나오도록 함
    if (!gs.incantationQueue || gs.incantationQueue.length === 0) {
        const aliveParticipants = gs.party.filter(p => p.hp > 0);
        gs.incantationQueue = shuffleArray([...aliveParticipants]);
    }
    const actor = gs.incantationQueue.shift();
    gs.turnOwner = actor;
    gs.isWaitingForInput = true;
    broadcastRoomState(roomId);
    syncInputState(roomId); // 강제 동기화 추가
    broadcastRoomLog(roomId, `[영창] ${actor.name}의 차례입니다.`, "system-msg");
}

// [안전장치] 워치독 타이머 - 10초 내 턴이 진행되지 않으면 자동 복구
function setTurnWatchdog(roomId) {
    const gs = rooms[roomId];
    if (!gs) return;
    // 이전 워치독 취소
    if (gs._watchdogTimer) clearTimeout(gs._watchdogTimer);
    gs._watchdogTimer = setTimeout(() => {
        const currentGs = rooms[roomId];
        if (!currentGs) return;
        if (currentGs.phase === 'COMBAT' || currentGs.phase === 'INCANTATION') {
            if (currentGs.isWaitingForInput) {
                console.log(`[워치독] 입력 대기 중 지연 감지 - 입력창 재동기화 (roomId: ${roomId})`);
                syncInputState(roomId);
                return;
            }

            console.log(`[워치독] 10초 경과 - 턴 자동 복구 (roomId: ${roomId}, phase: ${currentGs.phase})`);
            if (currentGs.phase === 'INCANTATION') {
                // 영창 모드에서 멈춘 경우 전투로 강제 복귀
                currentGs.phase = 'COMBAT';
                currentGs.completedIndices = [];
            }
            // 턴 큐 완전 재초기화
            try {
                startCombatCycle(roomId);
            } catch (e) {
                console.error('[워치독 복구 실패]', e);
                currentGs.isWaitingForInput = true;
                syncInputState(roomId);
            }
        }
    }, 10000);
}

// [안전장치] 안전한 지연 턴 전환 - setTimeout을 래핑하여 에러 발생 시에도 턴 진행 보장
function safeNextTurn(roomId, delay = 1000) {
    const gs = rooms[roomId];
    if (!gs) return;
    // 워치독 재설정
    setTurnWatchdog(roomId);
    setTimeout(() => {
        try {
            nextTurn(roomId);
        } catch (e) {
            console.error('[safeNextTurn 에러]', e);
            try { startCombatCycle(roomId); } catch (e2) {
                console.error('[startCombatCycle 복구 실패]', e2);
                if (rooms[roomId]) {
                    rooms[roomId].isWaitingForInput = true;
                    syncInputState(roomId);
                }
            }
        }
    }, delay);
}

function startEnding(roomId) {
    broadcastRoomLog(roomId, "✨ 폐가를 뒤덮었던 뒤틀린 풍경들이 한 줄기 정화의 빛과 함께 흩어지기 시작합니다. 절망스러웠던 비명과 속삭임은 사라지고, 그 자리에 깊고 평온한 침묵이 찾아옵니다.", "heal-msg");
    setTimeout(() => {
        broadcastRoomLog(roomId, "✨ 서로를 마주 보는 동료들의 얼굴에는 더 이상 공포가 아닌, 서로에 대한 굳건한 신뢰가 서려 있습니다. 폐가는 이제 무덤이 아닌 단순한 폐허일 뿐입니다.", "heal-msg");
        setTimeout(() => {
            broadcastRoomLog(roomId, "✨ 심연의 끝에서 돌아온 퇴마사들이여, 당신들은 서로의 이름을 부르며 어둠을 깨뜨렸습니다. 이제 흑주택의 저주는 끝났습니다.", "heal-msg");
            rooms[roomId].phase = 'CLEAR';
            broadcastRoomState(roomId);
        }, 4000);
    }, 4000);
}

function nextTurn(roomId) {
    const gameState = rooms[roomId];
    if (!gameState) return;

    // 워치독 갱신
    setTurnWatchdog(roomId);

    try {
        const aliveEnemies = gameState.enemies.filter(e => e.hp > 0);
        const hasCharmed = gameState.party.some(p => p.status.includes('매혹'));

        if (aliveEnemies.length === 0) {
            if (gameState.phase === 'COMBAT') {
                // 워치독 해제 (전투 종료)
                if (gameState._watchdogTimer) { clearTimeout(gameState._watchdogTimer); gameState._watchdogTimer = null; }
                gameState.party.forEach(p => p.status = []);
                gameState.turnOwner = null; // 전투 종료 시 턴 소유자 초기화
                broadcastRoomState(roomId);
                if (gameState.location === '1층 복도') {
                    gameState.phase = 'STORY_AFTER_COMBAT';
                    gameState.isWaitingForInput = true;
                    broadcastRoomLog(roomId, "✅ 전투 종료! 앞을 가로막는 괴물이 모두 사라지고 건너편에는 주방이 보입니다. 주방으로 이동하시겠습니까?", "system-msg");
                    syncInputState(roomId, "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
                } else if (gameState.location === '1층 주방 (식당)') {
                    gameState.phase = gameState.returnPhase || 'STORY_AFTER_KITCHEN';
                    gameState.returnPhase = null;
                    gameState.isWaitingForInput = true;
                    broadcastRoomLog(roomId, "✅ 전투 종료! 무엇을 진행하시겠습니까?", "system-msg");
                    syncInputState(roomId, "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
                } else if (gameState.location === '2층 안방') {
                    gameState.phase = 'STORY_AFTER_ROOM2F';
                    gameState.isMirrorGlitchActive = false; // 왜곡 해제
                    gameState.isWaitingForInput = true;
                    if (gameState.returnPhase === 'STORY_AFTER_ROOM2F') {
                        broadcastRoomLog(roomId, "✅ 상황 종료!", "system-msg");
                    } else {
                        broadcastRoomLog(roomId, "✅ 보스 처치!", "system-msg");
                    }
                    gameState.returnPhase = null;
                    syncInputState(roomId, "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
                } else if (gameState.location === '지하실 입구') {
                    gameState.phase = 'STORY_AFTER_BASEMENT_ENTRANCE';
                    gameState.isWaitingForInput = true;
                    broadcastRoomLog(roomId, "✅ 거구의 악귀를 쓰러뜨렸습니다! 철문 너머로 깊은 지하실 본당이 보입니다.", "system-msg");
                    syncInputState(roomId, "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
                } else if (gameState.location === '지하실 본당') {
                    // 최종 보스 태자귀 처치 시
                    gameState.phase = 'FINAL_ID_CHECK';
                    gameState.isWaitingForInput = false;
                    io.to(roomId).emit('darken_ui');
                    broadcastRoomLog(roomId, "🌑 태자귀가 비릿하게 웃으며 손을 뻗습니다. \"너희는 이 굴레에서 영원히 벗어나지 못한다.\"", "combat-msg");
                    setTimeout(() => {
                        broadcastRoomLog(roomId, "🌑 주변의 풍경이 일그러지며 태자귀의 목소리가 메아리 칩니다. \"가엾구나. 사실 네 곁에는 아무도 없다. 그들은 모두 내가 만든 환영일 뿐이지.\"", "combat-msg");
                        setTimeout(() => {
                            broadcastRoomLog(roomId, "🌑 \"그렇지 않다고 생각하나? 그렇다면 말해보거라 너가 지금까지 같이 해온 친구들의 이름과 너의 이름을\"", "combat-msg");
                            const idList = gameState.clients.map(c => c.nickname).join(', ');
                            syncInputState(roomId, `▶ 같이 진행해온 이들의 이름을 입력하세요. (예: ${idList})`);
                            gameState.isWaitingForInput = true;
                        }, 2500);
                    }, 2500);
                }
            }
            return;
        }

        let nextActor;
        while (!nextActor && gameState.currentTurnIndex < gameState.turnQueue.length) {
            let actor = gameState.turnQueue[gameState.currentTurnIndex];
            nextActor = gameState.party.find(p => p.id === actor.id && p.hp > 0) || gameState.enemies.find(e => e.id === actor.id && e.hp > 0);
            gameState.currentTurnIndex++;
        }

        // [태자귀 영창 기믹 체크]
        if (aliveEnemies.some(e => e.name === '태자귀')) {
            const boss = aliveEnemies.find(e => e.name === '태자귀');
            const hpPercent = (boss.hp / boss.maxHp) * 100;

            // 기믹 발동 조건 (70%, 50%, 25%, 5% 시점)
            let triggerPhase = 0;
            if (hpPercent <= 5 && boss.gimmickPhase < 4) triggerPhase = 4;
            else if (hpPercent <= 25 && boss.gimmickPhase < 3) triggerPhase = 3;
            else if (hpPercent <= 50 && boss.gimmickPhase < 2) triggerPhase = 2;
            else if (hpPercent <= 70 && boss.gimmickPhase < 1) triggerPhase = 1;

            if (triggerPhase > 0) {
                boss.gimmickPhase = triggerPhase;
                gameState.phase = 'INCANTATION';
                gameState.incantationIndex = 0; // 현재 순서 (0~7)

                const incantations = [
                    null,
                    "사불범정 만마항복", // 1단계
                    "금성철벽 천라지망", // 2단계
                    "파사현정 명경지수", // 3단계
                    "권선징악 인과응보"  // 4단계
                ];
                gameState.currentIncantation = incantations[triggerPhase].replace(/ /g, ''); // 공백 제거

                let alertMsg = "";
                if (triggerPhase === 1) alertMsg = "⚠️ 태자귀가 사악한 기운으로 덮치려고 합니다. 올바른 주문을 영창하여 기운을 막아야 합니다. 주문은 순서대로 외쳐야 합니다!";
                else if (triggerPhase === 2) alertMsg = "⚠️ 태자귀의 힘이 약해지고 있습니다. 봉인 주문을 위한 주문을 영창 하십시오! 주문은 순서대로 외쳐야 합니다!";
                else if (triggerPhase === 3) alertMsg = "⚠️ 태자귀가 환상을 걸어 혼란을 야기하려 합니다. 주문을 영창하여 혼란을 막아야 합니다. 주문은 순서대로 외쳐야 합니다!";
                else if (triggerPhase === 4) alertMsg = "⚠️ 태자귀가 무력화 되어가고 있습니다. 영원한 소멸을 위해 주문을 영창 하십시오! 주문은 순서대로 외쳐야 합니다!";

                broadcastRoomLog(roomId, alertMsg, "system-msg");
                broadcastRoomLog(roomId, "📢 순서: **[천화]** -> **[강림]** -> **[연화]** -> **[요한]**", "guide-msg");

                // 영창 모드 전용 턴 시작
                startIncantationTurn(roomId);
                return;
            }
        }

        if (!nextActor) { startCombatCycle(roomId); return; }

        gameState.turnOwner = nextActor;
        broadcastRoomState(roomId);

        if (gameState.party.find(p => p.id === nextActor.id)) {
            if (nextActor.status.includes('기절')) {
                broadcastRoomLog(roomId, `💤 ${nextActor.name}이 기절하여 턴을 넘깁니다...`, "combat-msg");
                nextActor.status = nextActor.status.filter(s => s !== '기절');
                broadcastRoomState(roomId);
                safeNextTurn(roomId, 1500);
                return;
            }
            if (nextActor.status.includes('매혹') || nextActor.status.includes('혼란')) {
                setTimeout(() => {
                    try {
                        const targets = gameState.party.filter(p => p.hp > 0);
                        const t = targets[Math.floor(Math.random() * targets.length)];
                        const dmg = Math.floor(Math.random() * 10) + 15;
                        t.hp = Math.max(0, t.hp - dmg);
                        broadcastRoomLog(roomId, `🌀 ${nextActor.name}이 환각 속에 아군 ${t.name}을 공격! (-${dmg})`, "combat-msg");
                        if (nextActor.status.includes('혼란')) {
                            nextActor.status = nextActor.status.filter(s => s !== '혼란');
                            broadcastRoomLog(roomId, `💡 충격으로 ${nextActor.name}의 혼란이 풀렸습니다!`);
                        }
                        broadcastRoomState(roomId);
                        safeNextTurn(roomId, 1500);
                    } catch (e) {
                        console.error('[매혹/혼란 처리 에러]', e);
                        safeNextTurn(roomId, 1500);
                    }
                }, 1000);
                return;
            }
            if (nextActor.status.includes('공포')) {
                nextActor.fearTurns = (nextActor.fearTurns || 0) + 1;
                if (nextActor.fearTurns >= 3) {
                    nextActor.status = nextActor.status.filter(s => s !== '공포');
                    nextActor.fearTurns = 0;
                    broadcastRoomLog(roomId, `💡 ${nextActor.name}이 공포를 극복하고 정신을 차렸습니다!`, "system-msg");
                } else {
                    broadcastRoomLog(roomId, `😨 ${nextActor.name}이 공포에 질려 아무것도 할 수 없습니다... (${nextActor.fearTurns}/3턴)`, "combat-msg");
                    broadcastRoomState(roomId);
                    safeNextTurn(roomId, 1500);
                    return;
                }
            }

            if (nextActor.mp < (nextActor.maxMp || 100)) {
                nextActor.mp = Math.min(nextActor.maxMp || 100, nextActor.mp + 3);
                broadcastRoomLog(roomId, `🍀 ${nextActor.name}의 MP가 자연적으로 회복됩니다. (+3)`, "guide-msg");
            }

            gameState.isWaitingForInput = true;
            // syncInputState가 broadcastRoomState 내부에 포함되어 있으나, 명시적으로 우선 호출하여 딜레이 방지
            syncInputState(roomId);
            broadcastRoomState(roomId);
            broadcastRoomLog(roomId, `[턴] ${nextActor.name}의 차례입니다.`, "system-msg");
        } else {
            if (nextActor.status.includes('기절')) {
                broadcastRoomLog(roomId, `💤 ${nextActor.name}이 기절하여 움직이지 못합니다.`, "combat-msg");
                nextActor.status = nextActor.status.filter(s => s !== '기절');
                // 수문장 거대 공격 저지 로직
                if (nextActor.name === '머리 없는 거구의 악귀' && nextActor.isCharging) {
                    nextActor.isCharging = false;
                    nextActor.chargeCount = 0;
                    broadcastRoomLog(roomId, `✨ **저지 성공!** ${nextActor.name}의 거대 공격이 무산되었습니다!`, "heal-msg");
                }
                safeNextTurn(roomId, 1500);
                return;
            }
            setTimeout(() => {
                try {
                    enemyAction(roomId, nextActor);
                } catch (e) {
                    console.error('[enemyAction 호출 에러]', e);
                    safeNextTurn(roomId, 1500);
                }
            }, 1500);
        }
    } catch (e) {
        console.error('[nextTurn 에러]', e);
        // 에러 발생 시 턴 큐 재초기화로 복구 시도
        try { startCombatCycle(roomId); } catch (e2) {
            console.error('[nextTurn 복구 실패]', e2);
            if (rooms[roomId]) {
                rooms[roomId].isWaitingForInput = true;
                syncInputState(roomId);
            }
        }
    }
}

function enemyAction(roomId, enemy) {
    const gameState = rooms[roomId];
    if (!gameState) return;
    try {
        const alive = gameState.party.filter(p => p.hp > 0);
        if (alive.length === 0) return;

        // 도발 타겟팅: 도발 중인 아군이 있으면 우선 타격
        const taanters = alive.filter(p => p.status.includes('도발방어'));
        const defaultTarget = taanters.length > 0 ? taanters[Math.floor(Math.random() * taanters.length)] : alive[Math.floor(Math.random() * alive.length)];

        // 피해 감소 계산 헬퍼 (task 38: 보스 스킬 등 특정 상황에서 방어 무시)
        const calcDmg = (baseDmg, target, ignoreDefense = false) => {
            if (ignoreDefense) return baseDmg;
            let dmg = baseDmg;
            if (target.status.includes('방어')) dmg = Math.floor(dmg * 0.5);
            if (target.status.includes('도발방어')) dmg = Math.floor(dmg * 0.3);
            if (gameState.coatBonusPlayerId === target.id) dmg = Math.max(1, dmg - 4);
            return dmg;
        };

        if (enemy.name === '굶주린 폴터가이스트') {
            broadcastRoomLog(roomId, `👻 ${enemy.name}가 주방의 온갖 사물들을 조종하여 일제히 투척합니다!`, "combat-msg");
            alive.forEach(t => {
                let dmg = calcDmg(Math.floor(Math.random() * 8) + 8, t);
                t.hp = Math.max(0, t.hp - dmg);
                broadcastRoomLog(roomId, `💥 날아온 집기가 ${t.name}에게 적중! (-${dmg})`, "combat-msg");
            });
        } else if (enemy.name === '몽마') {
            const t = defaultTarget;
            const rand = Math.random();
            if (rand < 0.45) { // 빈도 45%
                if (Math.random() < 0.8) { // 확률 80%
                    t.status.push('기절');
                    broadcastRoomLog(roomId, `🌀 ${enemy.name}가 방어할 수 없는 정신 공격으로 ${t.name}을 가둡니다! (기절)`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, `🌀 ${enemy.name}의 정신 공격을 ${t.name}이 간신히 버텨냈습니다!`, "combat-msg");
                }
            } else if (rand < 0.9) { // 빈도 45%
                if (Math.random() < 0.8) { // 확률 80%
                    t.status.push('공포');
                    t.fearTurns = 0;
                    broadcastRoomLog(roomId, `😨 ${enemy.name}가 영혼을 얼려버리는 환각을 보여줍니다! (공포)`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, `😰 ${enemy.name}가 보여준 공포를 ${t.name}이 정신력으로 이겨냈습니다!`, "combat-msg");
                }
            } else { // 빈도 10%
                let dmg = calcDmg(Math.floor(Math.random() * 15) + 10, t, true);
                t.hp = Math.max(0, t.hp - dmg);
                broadcastRoomLog(roomId, `🌑 ${enemy.name}가 ${t.name}의 생명력을 강제로 빨아들입니다! (-${dmg})`, "combat-msg");
                if (Math.random() < 0.33) { // 33% 확률로 회복
                    const healAmt = Math.floor(enemy.maxHp * 0.33);
                    enemy.hp = Math.min(enemy.maxHp, enemy.hp + healAmt);
                    broadcastRoomLog(roomId, `💉 ${enemy.name}가 빼앗은 생명력으로 자신의 상처를 치유합니다! (+${healAmt} HP)`, "heal-msg");
                }
            }
        } else if (enemy.name === '미혹귀') {
            const charmTargets = alive.filter(p => !p.status.includes('매혹'));
            if (charmTargets.length === 0) { // 모두 매혹 상태면 그냥 대기 타겟 공격 (하지만 미혹귀는 이제 매혹만 쓰므로 로그만)
                broadcastRoomLog(roomId, `💖 ${enemy.name}가 공허한 눈길로 이미 타락한 파티원들을 바라보며 비웃습니다.`, "combat-msg");
            } else {
                const isDouble = Math.random() < 0.15; // 15% 확률로 2명
                const actualTargets = isDouble && charmTargets.length >= 2 ? charmTargets.sort(() => 0.5 - Math.random()).slice(0, 2) : [charmTargets[Math.floor(Math.random() * charmTargets.length)]];

                actualTargets.forEach(t => {
                    if (Math.random() < 0.66 && t.job !== '사제가 아님' && t.job !== '사제') { // 66% 확률
                        t.status.push('매혹');
                        broadcastRoomLog(roomId, `💖 ${enemy.name}의 원념이 섞인 울음이 ${t.name}을 지배합니다! (매혹)`, "combat-msg");
                    } else if (t.job === '사제') {
                        broadcastRoomLog(roomId, `✨ ${t.name}은 성수로 무장한 신성한 기운으로 ${enemy.name}의 유혹을 물리칩니다!`, "guide-msg");
                    } else {
                        broadcastRoomLog(roomId, `💨 ${enemy.name}의 울음소리가 공허하게 울려 퍼집니다...`, "combat-msg");
                    }
                });
            }
        } else if (enemy.name === '머리 없는 거구의 악귀') {
            if (enemy.isCharging) {
                broadcastRoomLog(roomId, `🪓 ${enemy.name}가 치켜든 거대한 도끼를 지면으로 강하게 내리찍습니다!!`, "combat-msg");
                alive.forEach(t => {
                    let baseDmg = Math.floor(Math.random() * 41) + 40; // 40-80
                    let finalDmg = baseDmg;
                    if (t.status.includes('방어')) {
                        finalDmg = Math.floor(baseDmg * 0.2); // 방어 시 80% 감소
                        broadcastRoomLog(roomId, `🛡️ ${t.name}이(가) 방어로 충격을 견뎌냅니다! (-${finalDmg})`, "combat-msg");
                        t.status = t.status.filter(s => s !== '방어');
                    } else {
                        broadcastRoomLog(roomId, `💥 ${t.name}이(가) 엄청난 충격에 휩싸입니다! (-${finalDmg})`, "combat-msg");
                    }
                    t.hp = Math.max(0, t.hp - finalDmg);
                });
                enemy.isCharging = false;
                enemy.chargeCount = 0;
            } else {
                enemy.chargeCount = (enemy.chargeCount || 0) + 1;
                if (enemy.chargeCount >= 2) { // 2턴 차징 (기존 3턴)
                    enemy.isCharging = true;
                    broadcastRoomLog(roomId, `⚠️ **위기**: ${enemy.name}가 거대한 도끼를 높이 치켜듭니다!`, "combat-msg");
                    broadcastRoomLog(roomId, "다음 턴에 강력한 공격이 예상됩니다!", "guide-msg");
                } else {
                    let dmg = Math.floor(Math.random() * 21) + 20; // 방어 무시 (20-40)
                    defaultTarget.hp = Math.max(0, defaultTarget.hp - dmg);
                    broadcastRoomLog(roomId, `🔨 ${enemy.name}가 무거운 도끼 자루로 ${defaultTarget.name}을 후려칩니다! (-${dmg})`, "combat-msg");
                    if (Math.random() < 0.33) {
                        defaultTarget.status.push('기절');
                        broadcastRoomLog(roomId, `💫 ${enemy.name}의 육중한 타격에 ${defaultTarget.name}이 정신을 잃습니다! (기절)`, "combat-msg");
                    }
                }
            }
        } else if (enemy.name === '태자귀') {
            const targets = alive.sort(() => 0.5 - Math.random()).slice(0, 2);
            targets.forEach(t => {
                let dmg = calcDmg(Math.floor(Math.random() * 4) + 7, t); // 7-10 대미지
                t.hp = Math.max(0, t.hp - dmg);
                broadcastRoomLog(roomId, `💀 태자귀의 비릿한 기운이 ${t.name}을 덮칩니다! (-${dmg})`, "combat-msg");
            });
        } else if (alive.length > 0) {
            const t = defaultTarget;
            let dmg = calcDmg(Math.floor(Math.random() * 10) + 5, t);
            t.hp = Math.max(0, t.hp - dmg);
            broadcastRoomLog(roomId, `👻 ${enemy.name}의 공격! ${t.name}에게 ${dmg} 피해!`, "combat-msg");
        }
        broadcastRoomState(roomId);
        if (gameState.party.every(p => p.hp <= 0)) {
            gameState.phase = 'GAMEOVER';
            broadcastRoomLog(roomId, "☠️ 전멸했습니다.", "system-msg");
        } else {
            safeNextTurn(roomId, 1500);
        }
    } catch (e) {
        console.error('[enemyAction 에러]', e);
        safeNextTurn(roomId, 1500);
    }
}

function parseCommand(input) {
    const t = input.trim();
    const parts = t.split(' ');
    const actionStr = parts[0];
    const targetStr = parts.slice(1).join(' ');

    if (actionStr === '이동') return { action: 'MOVE', target: targetStr || 'NONE' };
    if (actionStr === '공격') return { action: 'ATTACK', target: targetStr || 'NONE' };
    if (actionStr === '스킬') {
        const skillName = parts[1];
        const skillTarget = parts.slice(2).join(' ');
        return { action: 'SKILL', skillName: skillName, target: skillTarget || 'NONE' };
    }
    if (t === '탐색') return { action: 'SEARCH', target: 'NONE' };
    if (actionStr === '탐색') return { action: 'SEARCH', target: targetStr };
    if (t === '둘러보기') return { action: 'LOOK' };
    if (t === '방어') return { action: 'DEFEND' };
    if (t === '진입') return { action: 'ENTER' };
    if (t === '개인정비') return { action: 'REST' };
    return { action: 'UNKNOWN' };
}

function executePlayerAction(roomId, actor, cmd, socket) {
    const gs = rooms[roomId];
    if (!gs) return;

    try {
        // [전투 중 둘러보기 (턴 비소모)]
        if (cmd.action === 'LOOK' && gs.phase === 'COMBAT') {
            broadcastRoomLog(roomId, `🔍 ${actor.name}이 전장을 살피며 상황을 파악합니다.`, "guide-msg");
            gs.waitCount = 0; // 대기 카운트 리셋
            if (gs.location === '2층 안방') {
                broadcastRoomLog(roomId, "안방에는 **[거울]**, **[옷장]**, **[침대]** 등이 보입니다. 본체는 거울 속에 있을지 모릅니다.", "guide-msg");
            } else if (gs.location === '1층 주방 (식당)') {
                gs.poltergeistState.lookCount++; // This was originally in the STORY_KITCHEN_FIND phase's LOOK action
                const spots = ['냉장고', '싱크대', '가스레인지', '전자레인지', '서랍장', '식탁'];
                const hint = gs.poltergeistState.hiddenSpot;
                const other = spots.filter(s => s !== hint)[Math.floor(Math.random() * 5)];
                broadcastRoomLog(roomId, `🔍 주변을 둘러봅니다... **[${hint}]** 혹은 **[${other}]** 쪽에서 이상한 기운이 느껴집니다!`, "guide-msg");
            }
            gs.isWaitingForInput = true;
            io.to(roomId).emit('turn_start', actor); // 입력창 다시 띄워주기
            broadcastRoomState(roomId);
            return;
        }

        // [특수 상황: 주방 폴터가이스트 기믹]
        if (gs.location === '1층 주방 (식당)' && gs.phase === 'COMBAT') {
            // The LOOK action for this phase is now handled by the general COMBAT LOOK above.
            // Only SEARCH remains specific to this block.
            if (cmd.action === 'SEARCH') {
                if (!cmd.target || cmd.target === 'NONE' || cmd.target.trim() === '') {
                    broadcastRoomLog(roomId, "무엇을 탐색할 지 몰라 허둥지둥 댑니다. (둘러보기를 사용하여 무엇을 탐색할지 찾아보세요)", "guide-msg");
                    safeNextTurn(roomId, 1000);
                    return;
                }
                if (cmd.target === gs.poltergeistState.hiddenSpot) {
                    const p = gs.enemies.find(e => e.name === '굶주린 폴터가이스트');
                    if (p) {
                        p.status = p.status.filter(s => s !== '은신');
                        broadcastRoomLog(roomId, `✨ 찾았다! **[${cmd.target}]** 속에 숨어있던 폴터가이스트가 모습을 드러냅니다!`, "system-msg");
                    }
                } else {
                    broadcastRoomLog(roomId, `💨 **[${cmd.target}]**에는 아무것도 없었습니다...`, "combat-msg");
                }
                safeNextTurn(roomId, 1000);
                return;
            }
        }

        // [특수 상황: 안방 보스전 거울 탐색 기믹]
        if (gs.location === '2층 안방' && gs.phase === 'COMBAT') {
            if (cmd.action === 'SEARCH') {
                if (cmd.target === '거울') {
                    const mihok = gs.enemies.find(e => (e.name === '미혹귀' || e.name === '몽마') && e.status.includes('은신'));
                    if (mihok) {
                        mihok.status = mihok.status.filter(s => s !== '은신');
                        broadcastRoomLog(roomId, `✨ 거울 속을 샅샅이 뒤져 숨어있던 **[${mihok.name}]**의 본체를 찾아냈습니다!`, "system-msg");
                    } else {
                        broadcastRoomLog(roomId, "거울 속에는 기괴하게 뒤틀린 파티원들의 모습만 비칩니다.", "guide-msg");
                    }
                } else {
                    broadcastRoomLog(roomId, "무엇을 탐색할 지 몰라 허둥지둥 댑니다. 무언가를 탐색 해야합니다.", "guide-msg");
                }
                safeNextTurn(roomId, 1000);
                return;
            }
        }

        if (cmd.action === 'ATTACK') {
            const t = gs.enemies.find(e => e.name === cmd.target && e.hp > 0) || gs.party.find(p => p.name === cmd.target && p.hp > 0);
            if (!t) {
                gs.isWaitingForInput = true;
                socket.emit('game_error', `대상을 찾을 수 없습니다: ${cmd.target}`);
                io.to(roomId).emit('turn_start', actor);
                return;
            }
            const isTK = gs.party.some(p => p.id === t.id);
            let dmg = Math.floor(Math.random() * 10) + 15; // New base damage: 15-24

            // [강림 부서진 도끼 보너스 적용] (task 103)
            if (actor.name === '강림' && actor.bonusDmg) {
                dmg += actor.bonusDmg;
            }
            if (t.status.includes('방어')) {
                dmg = Math.floor(dmg * 0.5);
                t.status = t.status.filter(s => s !== '방어');
            }
            if (t.status.includes('도발방어')) {
                dmg = Math.floor(dmg * 0.3);
                t.status = t.status.filter(s => s !== '도발방어');
            }
            if (gs.coatBonusPlayerId === t.id) {
                dmg = Math.max(1, dmg - 4);
                broadcastRoomLog(roomId, `🧥 코트의 보호로 피해가 감소합니다. (-4)`, "guide-msg");
            }
            if (isTK) { // Friendly fire logic
                const canBeWoken = t.status.includes('혼란') || t.status.includes('공포');
                if (canBeWoken) {
                    dmg = Math.floor(Math.random() * 6) + 5; // 상태이상 아군 타격 시 5~10
                    t.status = t.status.filter(s => s !== '혼란' && s !== '공포');
                    t.fearTurns = 0;
                    broadcastRoomLog(roomId, `💥 ${actor.name}이 ${t.name}을 때려 정신을 차리게 합니다! (-${dmg})`, "combat-msg");
                } else if (t.status.includes('매혹')) {
                    dmg = Math.floor(Math.random() * 6) + 5;
                    broadcastRoomLog(roomId, `⚠️ ${actor.name}이 매혹된 ${t.name}을 때렸지만 소용없습니다! (-${dmg})`, "combat-msg");
                } else {
                    // 일반 아군 공격 시 정상 데미지
                    broadcastRoomLog(roomId, `⚠️ ${actor.name}이 팀원 ${t.name}을 가차없이 공격했습니다! (-${dmg})`, "combat-msg");
                }
            } else if (t.status.includes('은신')) {
                broadcastRoomLog(roomId, `❌ 은신 중인 **[${t.name}]**을(를) 찾지 못해 공격이 빗나갔습니다!`, "combat-msg");
                broadcastRoomLog(roomId, "💡 보이지 않는 적을 상대하려면 거울이나 주변을 탐색해야 할지도 모릅니다.", "guide-msg");
                dmg = 0;
            } else {
                broadcastRoomLog(roomId, `⚔️ ${actor.name}의 공격! ${t.name}에게 ${dmg} 피해!`);
            }
            t.hp = Math.max(0, t.hp - dmg);
        } else if (cmd.action === 'SKILL') {
            const SKILL_COSTS = { '징치기': 10, '사인검베기': 15, '혼령묶기': 20, '성수뿌리기': 15 };

            // [직업별 스킬 제한] (task 106)
            const SKILL_JOB_MAP = {
                '징치기': '무당',       // 천화 전용
                '사인검베기': '퇴마사',  // 강림 전용
                '혼령묶기': '영매',    // 연화 전용
                '성수뿌리기': '사제'   // 요한 전용
            };
            const requiredJob = SKILL_JOB_MAP[cmd.skillName];
            if (requiredJob && actor.job !== requiredJob) {
                gs.isWaitingForInput = true;
                const JOB_NAME_MAP = { '무당': '천화', '퇴마사': '강림', '영매': '연화', '사제': '요한' };
                socket.emit('game_error', `${cmd.skillName}은(는) ${JOB_NAME_MAP[requiredJob] || requiredJob} 전용 스킬입니다!`);
                io.to(roomId).emit('turn_start', actor);
                return;
            }

            const cost = SKILL_COSTS[cmd.skillName] || 0;
            if (actor.mp < cost) {
                gs.isWaitingForInput = true;
                socket.emit('game_error', `MP가 부족합니다! (필요 MP: ${cost})`);
                io.to(roomId).emit('turn_start', actor);
                return;
            }
            actor.mp -= cost;

            if (cmd.skillName === '성수뿌리기') {
                const t = gs.party.find(p => p.name === cmd.target) || gs.enemies.find(e => e.name === cmd.target);
                if (!t) {
                    gs.isWaitingForInput = true;
                    socket.emit('game_error', '대상을 찾을 수 없습니다.');
                    io.to(roomId).emit('turn_start', actor);
                    return;
                }
                if (gs.party.includes(t)) {
                    t.hp = Math.min(t.maxHp, t.hp + 30);
                    const hasCharm = t.status.includes('매혹');
                    t.status = t.status.filter(s => s !== '매혹');
                    if (hasCharm) {
                        broadcastRoomLog(roomId, `✨ 요한의 성수! ${t.name}의 매혹이 풀리고 정신을 차립니다! (+30 HP)`, "heal-msg");
                    } else {
                        broadcastRoomLog(roomId, `✨ 요한의 성수! ${t.name}의 HP가 30 회복됩니다.`, "heal-msg");
                    }
                } else {
                    t.hp = Math.max(0, t.hp - 20);
                    broadcastRoomLog(roomId, `💦 요한이 던진 성수가 ${t.name}에게 정화의 고통을 줍니다! (-20)`, "combat-msg");
                }
            } else if (cmd.skillName === '사인검베기') {
                const t = gs.enemies.find(e => e.name === cmd.target && e.hp > 0);
                if (!t) {
                    gs.isWaitingForInput = true;
                    socket.emit('game_error', '적을 지정하세요.');
                    io.to(roomId).emit('turn_start', actor);
                    return;
                }
                if (t.status.includes('은신')) {
                    broadcastRoomLog(roomId, `❌ 은신 중인 **[${t.name}]**을(를) 찾지 못해 기술이 허공을 가릅니다!`, "combat-msg");
                    safeNextTurn(roomId, 1000);
                    return;
                }
                let dmg = 45;

                // [강림 부서진 도끼 보너스 적용] (task 103)
                if (actor.name === '강림' && actor.bonusDmg) {
                    dmg += actor.bonusDmg;
                }

                t.hp = Math.max(0, t.hp - dmg);
                broadcastRoomLog(roomId, `🗡️ 강림의 사인검이 빛을 뿜으며 ${t.name}을 베어 가릅니다! (-${dmg})`, "combat-msg");
            } else if (cmd.skillName === '혼령묶기') {
                const t = gs.enemies.find(e => e.name === cmd.target && e.hp > 0);
                if (!t) {
                    gs.isWaitingForInput = true;
                    socket.emit('game_error', '적을 지정하세요.');
                    io.to(roomId).emit('turn_start', actor);
                    return;
                }
                if (t.status.includes('은신')) {
                    broadcastRoomLog(roomId, `❌ 은신 중인 **[${t.name}]**에게 혼령을 보냈으나 실체를 찾지 못했습니다!`, "combat-msg");
                    safeNextTurn(roomId, 1000);
                    return;
                }
                t.status.push('기절');
                broadcastRoomLog(roomId, `🕸️ 연화가 부리는 혼령들이 ${t.name}의 움직임을 완전히 봉쇄합니다! (기절)`, "combat-msg");
                if (t.name === '머리 없는 거구의 악귀' && t.isCharging) {
                    const backlash = Math.floor(Math.random() * 11) + 15; // 15~25 대미지
                    actor.hp = Math.max(0, actor.hp - backlash);
                    broadcastRoomLog(roomId, `⚡ 강력한 힘의 반동이 연화의 육신을 덮칩니다! (-${backlash})`, "combat-msg");
                }
            } else if (cmd.skillName === '징치기') {
                actor.status.push('도발방어');
                broadcastRoomLog(roomId, `🥁 천화가 징을 크게 울려 적들의 시선을 끌고 방어 태세를 갖춥니다!`, "heal-msg");
            } else {
                gs.isWaitingForInput = true;
                broadcastRoomLog(roomId, "집중하세요! 정확한 스킬명을 입력해야 합니다.", "guide-msg");
                io.to(roomId).emit('turn_start', actor);
                return;
            }
        } else if (cmd.action === 'DEFEND') {
            actor.status.push('방어');
            broadcastRoomLog(roomId, `🛡️ ${actor.name}이 방어 태세를 취합니다.`);
        } else if (cmd.action === 'SEARCH') {
            gs.enemies.forEach(e => { e.status = e.status.filter(s => s !== '은신'); });
            broadcastRoomLog(roomId, `🔍 ${actor.name}이 주변을 샅샅이 탐색하여 숨은 적을 찾아냅니다.`);
        }

        broadcastRoomState(roomId);

        // [폴터가이스트 전용 기믹: 50% 이하 재은신]
        if (gs.location === '1층 주방 (식당)' && gs.phase === 'COMBAT') {
            const polter = gs.enemies.find(e => e.name === '굶주린 폴터가이스트' && e.hp > 0);
            if (polter && polter.hp <= polter.maxHp * 0.5 && !gs.poltergeistState.hasRehidden) {
                const isBound = polter.status.some(s => s.includes('기절') || s.includes('묶임'));
                if (isBound) {
                    broadcastRoomLog(roomId, `🔗 **[${polter.name}]**이 영매의 혼령들에 묶여 도망가지 못하고 모습을 드러낸 채 괴성을 지릅니다!`, "combat-msg");
                    gs.poltergeistState.hasRehidden = true; // 기회 상실
                } else {
                    gs.poltergeistState.hasRehidden = true;
                    polter.status.push('은신');
                    const spots = ['냉장고', '싱크대', '가스레인지', '전자레인지', '서랍장', '식탁'];
                    gs.poltergeistState.hiddenSpot = spots[Math.floor(Math.random() * spots.length)];
                    gs.poltergeistState.lookCount = 0;
                    gs.phase = 'STORY_KITCHEN_FIND'; // 다시 탐색 모드로 전환
                    broadcastRoomLog(roomId, `💨 **[${polter.name}]**이 체력이 떨어지자 비명을 지르며 다시 주방 구석으로 숨어버렸습니다!`, "combat-msg");
                    broadcastRoomLog(roomId, "💡 다시 **[둘러보기]**와 **[탐색]**을 통해 본체를 찾아야 합니다!", "guide-msg");
                    broadcastRoomState(roomId);
                    // 재은신 시에는 즉시 입력 권한을 스토리 가이드와 함께 복구
                    setTimeout(() => {
                        gs.isWaitingForInput = true;
                        syncInputState(roomId, "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                    }, 1000);
                    return; // 현재 턴 종료 후 탐색 모드로 대기
                }
            }
        }

        safeNextTurn(roomId, 1000);
    } catch (e) {
        console.error('[executePlayerAction 에러]', e);
        const gs = rooms[roomId];
        if (gs) {
            gs.isWaitingForInput = true;
            syncInputState(roomId, "⚠️ 기술/공격 처리 중 오류가 발생했습니다. 다시 입력하십시오.");
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on ${PORT}`); });
