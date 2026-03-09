const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
        clients: [], // { socketId, nickname }
        party: JSON.parse(JSON.stringify(STARTING_PARTY)),
        enemies: [],
        turnQueue: [],
        currentTurnIndex: 0,
        isWaitingForInput: false,
        location: '알 수 없음',
        waitCount: 0,
        hasRested: false,
        returnPhase: null,
        fridgeSearched: false,
        drawerSearched: false,
        room2fClosetSearched: false,
        room2fVanitySearched: false,
        room2fDrawerSearched: false,
        coatBonusPlayerId: null,
        poltergeistState: null,
        waitingForCoatUser: false,
        turnOwner: null
    };
}

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
                    const prompts = {
                        'STORY_ENTRANCE': "▶ '진입' 이라고 명령하십시오.",
                        'STORY_HALLWAY': "▶ '전투 준비' 라고 명령하십시오.",
                        'STORY_KITCHEN_WAIT': "▶ '전투 준비' 라고 명령하십시오.",
                        'STORY_KITCHEN_FIND': "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.",
                        'STORY_2F_HALLWAY': "▶ '이동 안방', '대기', '탐색' 중 선택하십시오.",
                        'STORY_AFTER_COMBAT': "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.",
                        'STORY_AFTER_KITCHEN': "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.",
                        'STORY_AFTER_ROOM2F': "▶ '이동', '둘러보기', '탐색 [대상]', '개인정비' 중 선택하십시오."
                    };
                    socket.emit('story_input_start', prompts[room.phase] || "작전이 진행 중입니다. 명령을 입력하세요.");
                }
            } else {
                socket.emit('turn_wait');
            }
        }
    });

    socket.on('select_chapter', (chId) => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo) return;
        roomInfo.gameState.phase = 'LOBBY_WAITING';
        socket.emit('chapter_selected', chId);
        io.to(roomInfo.roomId).emit('lobby_update', roomInfo.gameState.clients, roomInfo.gameState.isStarted);
    });

    socket.on('chat_message', (msg) => {
        const roomInfo = getSocketRoom(socket);
        const senderName = socket.nickname || '익명';
        if (roomInfo) {
            io.to(roomInfo.roomId).emit('chat_message', { sender: senderName, msg: msg, type: 'user' });
        }
    });

    socket.on('start_game', () => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo || roomInfo.gameState.isStarted) return;
        const { roomId, gameState } = roomInfo;

        gameState.isStarted = true;
        gameState.phase = 'STORY_ENTRANCE';
        gameState.location = '흑주택 앞';

        io.to(roomId).emit('game_started');
        io.to(roomId).emit('location_update', gameState.location);
        io.to(roomId).emit('lobby_update', gameState.clients, gameState.isStarted);
        broadcastRoomState(roomId);
        broadcastRoomList();

        setTimeout(() => {
            broadcastRoomLog(roomId, "...어둠이 내려앉은 야산의 중턱.", "system-msg");
            setTimeout(() => {
                broadcastRoomLog(roomId, "안개 속에서 거대한 폐가의 실루엣이 드러납니다. <b>[1급 위험 지정 구역: 흑주택]</b>", "system-msg");
                broadcastRoomLog(roomId, "기분 나쁜 한기와 함께 썩은 내가 진동합니다.");
                broadcastRoomLog(roomId, `[안내] <b>누구든 먼저 명령어를 입력</b>하여 파티를 조작할 수 있습니다.`, "guide-msg");

                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '진입' 이라고 명령하십시오.");
            }, 1000);
        }, 1000);
    });

    socket.on('user_input', (txt) => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo || !roomInfo.gameState.isStarted) return;
        const { roomId, gameState } = roomInfo;
        const nickname = socket.nickname || '익명';
        const trimmed = txt.trim();
        if (trimmed === '') return;

        // [전멸: 로비 복귀 처리]
        if (gameState.phase === 'GAMEOVER') {
            if (trimmed === '로비로 돌아가기') {
                const clientsSnapshot = gameState.clients;
                rooms[roomId] = createInitialGameState();
                rooms[roomId].clients = clientsSnapshot;
                io.to(roomId).emit('force_lobby');
                broadcastRoomList();
            }
            return;
        }

        // [스토리 1: 현관 진입]
        if (gameState.phase === 'STORY_ENTRANCE') {
            if (!gameState.isWaitingForInput) return;
            if (trimmed === '진입') {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_HALLWAY';
                    gameState.location = '1층 복도';
                    gameState.waitCount = 0; // 초기화
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "끼이익... 무거운 나무문이 열립니다.", "system-msg");
                    broadcastRoomLog(roomId, "1층 복도는 칠흑같이 어둡습니다. 벽에는 누군가 긁어놓은 듯한 손톱자국이 가득합니다.");
                    broadcastRoomLog(roomId, "...그때, 어둠 속에서 붉은 안광 두 짝이 번쩍입니다!");
                    broadcastRoomLog(roomId, "기괴한 울음소리를 내는 '짐승령'과 바닥을 기어오는 '하급 지박령'이 길을 막습니다.");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '전투 준비' 라고 명령하십시오.");
                    }, 1500);
                }, 1000);
            } else if (trimmed === '대기') {
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "폭풍전야의 고요함이 흑주택 주위를 감쌉니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                io.to(roomId).emit('story_input_start', "▶ '진입' 이라고 명령하십시오.");
            }
            return;
        }

        // [스토리 2: 복도 전투 돌입]
        if (gameState.phase === 'STORY_HALLWAY') {
            if (!gameState.isWaitingForInput) return;
            if (trimmed === '전투 준비') {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'COMBAT';
                    broadcastRoomLog(roomId, "⚔️ 전투가 시작됩니다!", "system-msg");
                    gameState.enemies = [
                        { id: 'e1', name: '짐승령', hp: 60, maxHp: 60, status: [] },
                        { id: 'e2', name: '하급 지박령', hp: 40, maxHp: 40, status: [] }
                    ];
                    startCombatCycle(roomId);
                }, 1000);
            } else if (trimmed === '대기') {
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "어둠 속에서 무언가 꿈틀대고 있습니다. 서둘러야 합니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                io.to(roomId).emit('story_input_start', "▶ '전투 준비' 라고 명령하십시오.");
            }
            return;
        }

        // [복도 클리어 후 선택지]
        if (gameState.phase === 'STORY_AFTER_COMBAT') {
            if (!gameState.isWaitingForInput) return; // 잠금장치
            const cmd = parseCommand(trimmed);
            if (trimmed === '대기') {
                gameState.isWaitingForInput = false; // 즉시 잠금
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "파티원들은 팽팽한 긴장감 속에 무기를 쥐고 주변을 경계합니다. 어둠 속에서 무언가 다시 튀어나올 것만 같습니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
            }
            else if (trimmed === '개인정비' || (cmd && cmd.action === 'REST')) {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 개인정비`, "user-cmd-msg");
                if (gameState.hasRested) {
                    broadcastRoomLog(roomId, "이미 주변의 쓸만한 물품을 다 사용하여 더 이상 정비할 수 없습니다.");
                } else {
                    gameState.hasRested = true;
                    broadcastRoomLog(roomId, "파티원들이 잠시 숨을 고르며 전열을 가가듬습니다.");
                    gameState.party.forEach(p => {
                        const ratio = 0.1 + Math.random() * 0.1; // 10%~20%
                        const hpRec = Math.floor(p.maxHp * ratio);
                        const mpRec = Math.floor((p.maxMp || 100) * ratio);
                        p.hp = Math.min(p.maxHp, p.hp + hpRec);
                        p.mp = Math.min(p.maxMp || 100, p.mp + mpRec);
                        broadcastRoomLog(roomId, `🍀 ${p.name}: HP +${hpRec}, MP +${mpRec} 회복`, "heal-msg");
                    });
                    broadcastRoomState(roomId);
                }
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
            } else if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 탐색`, "user-cmd-msg");
                broadcastRoomLog(roomId, "🔦 복도를 훑어봅니다. 벽면에는 마르지 않은 핏자국이 기괴한 무늬를 그리며 흘러내리고 있고, 낡은 벽지 뒤로 빛바랜 부적의 흔적들이 보입니다. 건물이 누군가를 가두기 위해 설계된 것 같은 불길한 느낌이 듭니다.", "system-msg");
                broadcastRoomLog(roomId, "아이콘 클릭 대신 명령어를 입력하여 다음 구역으로 넘어가세요. 건너편 통로에 주방이 보입니다.");
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
            }
            else if (trimmed === '이동' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false; // 즉시 잠금
                gameState.waitCount = 0;
                gameState.hasRested = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 이동`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_KITCHEN_WAIT';
                    gameState.location = '1층 주방 (식당)';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "피 냄새가 짙게 깔린 서늘한 공기를 따라 주방으로 들어섭니다.", "system-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '전투 준비' 라고 명령하십시오.");
                    }, 1500);
                }, 1000);
            }
            return;
        }

        // [주방 전투 준비]
        if (gameState.phase === 'STORY_KITCHEN_WAIT') {
            if (!gameState.isWaitingForInput) return;
            if (trimmed === '전투 준비') {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0; // 리셋
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_KITCHEN_FIND';
                    broadcastRoomLog(roomId, "⚔️ 폴터가이스트와의 전투가 시작됩니다! 본체를 찾아내야 합니다!", "system-msg");
                    broadcastRoomLog(roomId, "💡 적의 모습이 보이지 않습니다! (명령어 '둘러보기' 혹은 '탐색' 필요)", "guide-msg");
                    const spots = ['냉장고', '싱크대', '가스레인지', '전자레인지', '서랍장', '식탁'];
                    gameState.poltergeistState = { hiddenSpot: spots[Math.floor(Math.random() * spots.length)], hasRehidden: false, lookCount: 0 };
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '둘러보기' 명령어를 입력하여 주변 사물을 확인하세요.");
                }, 1000);
            } else if (trimmed === '대기') {
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "주방의 차가운 정적이 흐릅니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                io.to(roomId).emit('story_input_start', "▶ '전투 준비' 라고 명령하십시오.");
            }
            return;
        }

        // [주방 본체 찾기 전용 페이즈]
        if (gameState.phase === 'STORY_KITCHEN_FIND') {
            if (!gameState.isWaitingForInput) return;
            const cmd = parseCommand(trimmed);
            if (trimmed !== '대기') {
                gameState.waitCount = 0; // 대기 아닌 행동 시 리셋
            }
            if (trimmed === '대기' || cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false; // 상태 변화 행동 잠금
            }
            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
            if (trimmed === '대기') {
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "투명한 공포 속에 몸을 떨며 주변을 살핍니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
            } else if (cmd.action === 'LOOK') {
                gameState.isWaitingForInput = false;
                gameState.poltergeistState.lookCount++;
                if (gameState.poltergeistState.lookCount === 1) {
                    broadcastRoomLog(roomId, "🔍 주방 한켠에 **[냉장고]**, **[싱크대]**, **[가스레인지]**가 보입니다. 더 둘러보시겠습니까? 아니면 탐색해보시겠습니까?", "guide-msg");
                } else {
                    broadcastRoomLog(roomId, "🔍 주방 다른 한켠에 **[전자레인지]**, **[서랍장]**, **[식탁]**이 보입니다. 이제 의심되는 곳을 탐색해보십시오!", "guide-msg");
                }
            } else if (cmd.action === 'SEARCH') {
                if (!cmd.target || cmd.target === 'NONE' || cmd.target.trim() === '') {
                    broadcastRoomLog(roomId, "무엇을 탐색할 지 몰라 허둥지둥 댑니다. (둘러보기를 사용하여 무엇을 탐색할지 찾아보세요)", "guide-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                        broadcastRoomState(roomId);
                    }, 1000);
                    return;
                }
                if (cmd.target === gameState.poltergeistState.hiddenSpot) {
                    gameState.phase = 'COMBAT';
                    let polter = gameState.enemies.find(e => e.name === '굶주린 폴터가이스트');
                    if (polter) {
                        polter.status = polter.status.filter(s => s !== '은신');
                    } else {
                        gameState.enemies = [{ id: 'e3', name: '굶주린 폴터가이스트', hp: 120, maxHp: 120, status: [] }];
                    }
                    broadcastRoomLog(roomId, `✨ 찾았다! **[${cmd.target}]** 속에 숨어있던 폴터가이스트가 모습을 드러냅니다!`, "system-msg");
                    broadcastRoomLog(roomId, "⚔️ 이제 공격이 가능합니다!", "combat-msg");
                    startCombatCycle(roomId);
                    return;
                } else {
                    broadcastRoomLog(roomId, `💨 **[${cmd.target}]**에는 아무것도 없었습니다...`, "combat-msg");
                    // 탐색 실패 시 폴터가이스트의 기습 (랜덤 1인 피해)
                    const alive = gameState.party.filter(p => p.hp > 0);
                    const t = alive[Math.floor(Math.random() * alive.length)];
                    const dmg = 15;
                    t.hp = Math.max(0, t.hp - dmg);
                    broadcastRoomLog(roomId, `😨 정적을 깨고 폴터가이스트가 기습합니다! ${t.name}에게 ${dmg} 피해!`, "combat-msg");
                    if (gameState.enemies.length > 0) {
                        // 이미 전투 중인 경우(재은신 후 탐색 실패) 턴을 넘김
                        setTimeout(() => nextTurn(roomId), 1000);
                        return;
                    } else {
                        // 스토리 단계에서 탐색 실패 시 입력 복구
                        setTimeout(() => {
                            gameState.isWaitingForInput = true;
                            io.to(roomId).emit('story_input_start', "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                            broadcastRoomState(roomId);
                        }, 1000);
                        return;
                    }
                }
            }
            io.to(roomId).emit('story_input_start', "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
            return;
        }

        // [전투 모드]
        if (gameState.phase === 'COMBAT') {
            if (!gameState.isWaitingForInput) return; // 중복 입력 방지 잠금장치
            if (!gameState.turnOwner) return;
            const isPartyTurn = gameState.party.some(p => p.id === gameState.turnOwner.id);
            if (!isPartyTurn) return;
            const cmd = parseCommand(trimmed);
            if (!cmd || cmd.action === 'UNKNOWN') {
                socket.emit('game_error', '올바른 전투 명령을 입력하세요. (공격, 스킬, 방어, 둘러보기, 탐색)');
                return;
            }

            // 즉시 잠금: 명령이 유효하면 즉시 입력을 차단하여 더블 클릭 방지
            gameState.isWaitingForInput = false;
            io.to(roomId).emit('turn_wait');

            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span> <b>${gameState.turnOwner.name}</b>: ${trimmed}`, "user-cmd-msg");
            executePlayerAction(roomId, gameState.turnOwner, cmd, socket);
            return;
        }

        // [영창 모드]
        if (gameState.phase === 'INCANTATION') {
            if (!gameState.isWaitingForInput) return;
            const owner = gameState.turnOwner;
            if (!owner) return;

            gameState.isWaitingForInput = false;
            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span> <b>${owner.name}</b>: ${trimmed}`, "user-cmd-msg");

            const expectedIncantation = gameState.currentIncantation;
            const charMap = { '무당': [0, 4], '퇴마사': [1, 5], '영매': [2, 6], '사제': [3, 7] };
            const myIndices = charMap[owner.job] || [];

            // 현재 캐릭터가 입력해야 할 글자가 무엇인지 확인
            // (이미 입력된 글자 수를 기반으로 다음 담당 글자를 찾음)
            const myExpectedChar = myIndices.map(idx => expectedIncantation[idx]).find((char, i) => {
                // 이전에 내가 몇 번 입력했는지 체크 (단순히 index 기반이면 꼬일 수 있으므로 로직 정교화 필요)
                // 하지만 사용자의 시나리오대로라면 '8번의 턴 동안 각자 자기 글자 2개씩'이므로
                // 현재 캐릭터가 이번 영창 페이즈에서 몇 번째 입력을 시도하는지 추적하는 상수가 필요할 수 있음.
                // 일단은 캐릭터 직업별로 담당 인덱스의 글자 중 아직 '완성되지 않은' 글자를 찾는 방식으로 구현.
                return char !== undefined;
            });

            // 사용자 시나리오: 1. 캐릭터 이름과 주문 순서 강제 매칭 / 2. 무작위 턴 배정
            // 정답 체크: 현재 턴인 캐릭터(owner.job)의 담당 글자들 중 하나가 입력값(trimmed)과 일치해야 함
            const correctIndex = myIndices.find(idx => expectedIncantation[idx] === trimmed);

            if (correctIndex !== undefined) {
                // 중복 입력 방지: 이미 해당 인덱스가 채워졌는지 확인 (필요시 gameState에 기록)
                if (!gameState.completedIndices) gameState.completedIndices = [];

                if (gameState.completedIndices.includes(correctIndex)) {
                    broadcastRoomLog(roomId, `‼️ **이미 외친 글자입니다!** (${trimmed})`, "combat-msg");
                    // 실패 처리로 이어짐
                } else {
                    broadcastRoomLog(roomId, `✨ **정확합니다!** ${owner.name}의 외침이 공명합니다. (${trimmed})`, "heal-msg");
                    gameState.completedIndices.push(correctIndex);
                    gameState.incantationIndex++; // 전체 완성 개수 카운트

                    if (gameState.incantationIndex >= expectedIncantation.length) {
                        // 기믹 성공
                        gameState.phase = 'COMBAT';
                        const boss = gameState.enemies.find(e => e.name === '태자귀');
                        boss.status.push('기절');
                        broadcastRoomLog(roomId, "✨ **영창 성공!** 강력한 신성력이 태자귀를 억누릅니다! (2턴 간 기절)", "heal-msg");
                        gameState.completedIndices = [];
                        setTimeout(() => nextTurn(roomId), 1500);
                    } else {
                        // 다음 무작위 턴 가동
                        setTimeout(() => startIncantationTurn(roomId), 1000);
                    }
                    return;
                }
            }

            // 위 조건에 걸리지 않으면 실패 처리
            gameState.phase = 'COMBAT';
            gameState.completedIndices = [];
            const boss = gameState.enemies.find(e => e.name === '태자귀');
            if (boss.gimmickPhase === 1 || boss.gimmickPhase === 3) {
                broadcastRoomLog(roomId, "‼️ **영창 실패!** 흐트러진 주문의 기운이 파티를 덮칩니다!", "combat-msg");
                gameState.party.forEach(p => {
                    if (p.job !== '사제') {
                        const states = ['매혹', '공포', '기절'];
                        p.status.push(states[Math.floor(Math.random() * 3)]);
                    }
                });
            } else {
                const healAmt = Math.floor(boss.maxHp * 0.1);
                boss.hp = Math.min(boss.maxHp, boss.hp + healAmt);
                broadcastRoomLog(roomId, `‼️ **영창 실패!** 태자귀가 부정한 기운을 흡수하여 상처를 회복합니다! (+${healAmt} HP)`, "combat-msg");
            }
            // 기믹 실패 시 해당 페이즈를 한 단계 낮춰서 나중에 다시 발동하도록 조치 (50% 재발동 이슈 해결)
            boss.gimmickPhase = Math.max(0, boss.gimmickPhase - 1);

            broadcastRoomState(roomId);
            setTimeout(() => nextTurn(roomId), 1500);
            return;
        }

        // [최종 엔딩: ID 검증 모드]
        if (gameState.phase === 'FINAL_ID_CHECK') {
            if (!gameState.isWaitingForInput) return;
            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: ${trimmed}`, "user-cmd-msg");

            const requiredIds = gameState.clients.map(c => c.nickname).sort().join(',');
            const inputIds = trimmed.split(',').map(s => s.trim()).sort().join(',');

            if (requiredIds === inputIds) {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "✨ **진실의 목소리**: 환상이 깨지며 동료들의 온기가 선명해집니다.", "heal-msg");
                setTimeout(() => startEnding(roomId), 2000);
            } else {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "🌑 **태자귀**: \"후후... 가엾은 것...\"", "combat-msg");
                setTimeout(() => {
                    // 5시나리오 시작점으로 회귀 및 UI 복구
                    gameState.phase = 'STORY_BASEMENT_CORE_ENTRY';
                    gameState.location = '지하실 본당';
                    gameState.enemies = [];
                    io.to(roomId).emit('restore_ui'); // UI 복구 이벤트
                    broadcastRoomLog(roomId, "⏳ 시간과 공간이 뒤틀리며 다시 본당 입구로 돌아왔습니다.", "system-msg");
                    broadcastRoomState(roomId);
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '문자를 확인한다' 라고 입력하십시오.");
                    }, 1500);
                }, 2000);
            }
            return;
        }

        // [주방 클리어 후 선택지]
        if (gameState.phase === 'STORY_AFTER_KITCHEN') {
            if (!gameState.isWaitingForInput) return;
            const cmd = parseCommand(trimmed);
            if (trimmed === '대기') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 대기`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "식당의 적막 속에 누군가의 숨소리만 들립니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (trimmed === '개인정비' || (cmd && cmd.action === 'REST')) {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 개인정비`, "user-cmd-msg");
                if (gameState.hasRested) broadcastRoomLog(roomId, "이미 정비를 마쳤습니다.");
                else {
                    gameState.hasRested = true;
                    broadcastRoomLog(roomId, "파티원들이 주방 구석에서 잠시 휴식을 취합니다.");
                    gameState.party.forEach(p => {
                        const ratio = 0.1 + Math.random() * 0.1;
                        const hpRec = Math.floor(p.maxHp * ratio);
                        const mpRec = Math.floor((p.maxMp || 100) * ratio);
                        p.hp = Math.min(p.maxHp, p.hp + hpRec);
                        p.mp = Math.min(p.maxMp || 100, p.mp + mpRec);
                        broadcastRoomLog(roomId, `🍀 ${p.name}: HP +${hpRec}, MP +${mpRec} 회복`, "heal-msg");
                    });
                    broadcastRoomState(roomId);
                }
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
            } else if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                if (cmd.target === '냉장고') {
                    if (gameState.fridgeSearched) broadcastRoomLog(roomId, "냉장고는 비어 있습니다.");
                    else {
                        gameState.fridgeSearched = true;
                        if (Math.random() < 0.5) {
                            broadcastRoomLog(roomId, "✨ 운 좋게 신선한 음식을 발견했습니다! (+30)", "heal-msg");
                            gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + 30); p.mp = Math.min(p.maxMp || 100, p.mp + 30); });
                        } else {
                            broadcastRoomLog(roomId, "🤢 상한 음식을 먹고 배탈이 났습니다! (-15)", "combat-msg");
                            gameState.party.forEach(p => { p.hp = Math.max(0, p.hp - 15); p.mp = Math.max(0, p.mp - 15); });
                        }
                        broadcastRoomState(roomId);
                    }
                } else if (cmd.target === '서랍장') {
                    if (gameState.drawerSearched) broadcastRoomLog(roomId, "서랍장은 이미 비어 있습니다.");
                    else {
                        gameState.drawerSearched = true;
                        if (Math.random() < 0.6) {
                            broadcastRoomLog(roomId, "📜 서랍장에서 정체불명의 종이 조각을 발견하여 읽습니다. 무언가 깨달음을 얻어 지능이 상승합니다! (최대 MP +10)", "heal-msg");
                            gameState.party.forEach(p => { p.maxMp = (p.maxMp || 100) + 10; p.mp += 10; });
                            broadcastRoomState(roomId);
                        } else {
                            broadcastRoomLog(roomId, "😱 서랍장을 열자 공포스러운 환각과 함께 하급 지박령이 튀어나옵니다!", "combat-msg");
                            gameState.returnPhase = 'STORY_AFTER_KITCHEN';
                            gameState.phase = 'COMBAT';
                            gameState.enemies = [{ id: 'e_sub', name: '하급 지박령', hp: 40, maxHp: 40, status: [] }];
                            startCombatCycle(roomId);
                            return;
                        }
                    }
                } else {
                    broadcastRoomLog(roomId, "주방 안쪽에 <b>[냉장고]</b>와 <b>[서랍장]</b>이 보입니다.");
                }
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
            } else if (trimmed === '이동 2층' || (cmd && cmd.action === 'MOVE' && cmd.target === '2층')) {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                gameState.hasRested = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 이동 2층`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_2F_HALLWAY';
                    gameState.location = '2층 복도';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🕯️ 2층 복도에 발을 들이자, 차가운 냉기가 전신을 감쌉니다. 복도 벽에 걸린 낡은 초상화들이 파티원들의 움직임을 따라 눈동자를 굴리는 듯한 기괴한 착각이 듭니다. 복도 끝 굳게 닫힌 안방 문 틈으로 보랏빛 안개가 소리 없이 흘러나오고 있습니다. 무엇을 하시겠습니까?", "system-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색' 중 선택하십시오.");
                    }, 1500);
                }, 1000);
                return;
            } else {
                broadcastRoomLog(roomId, "원하시는 행동(이동 2층, 탐색, 개인정비, 대기)을 입력하세요.");
            }
            io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
            return;
        }

        // [2층 복도 선택지]
        if (gameState.phase === 'STORY_2F_HALLWAY') {
            if (!gameState.isWaitingForInput) return;
            const cmd = parseCommand(trimmed);
            if (trimmed === '대기') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 대기`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "파티원들은 삐걱거리는 복도 한가운데서 숨을 죽인 채 안방 쪽을 응시합니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색' 중 선택하십시오.");
            } else if (trimmed === '이동 안방' || trimmed === '이동' || (cmd && cmd.action === 'MOVE' && (cmd.target === '안방' || cmd.target === 'NONE'))) {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] </span>: 이동 안방`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.location = '2층 안방';
                    gameState.phase = 'COMBAT';
                    gameState.isMirrorGlitchActive = true;
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🚪 안방 문을 열자 거울 속 원혼들이 공격해옵니다!", "system-msg");
                    gameState.enemies = [
                        { id: 'e4', name: '몽마', hp: 250, maxHp: 250, status: [] },
                        { id: 'e5', name: '미혹귀', hp: 200, maxHp: 200, status: ['은신'] }
                    ];
                    startCombatCycle(roomId);
                }, 1000);
            } else if (cmd && cmd.action === 'SEARCH') {
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 탐색`, "user-cmd-msg");
                if (cmd.target === '서랍장' && !gameState.room2fDrawerSearched) {
                    gameState.room2fDrawerSearched = true;
                    broadcastRoomLog(roomId, "📜 서랍장에서 기괴한 고문서를 발견하여 읽습니다. 최대 MP가 상승합니다! (최대 MP +10)", "heal-msg");
                    gameState.party.forEach(p => { p.maxMp = (p.maxMp || 100) + 10; p.mp += 10; });
                    broadcastRoomState(roomId);
                } else {
                    broadcastRoomLog(roomId, "🔦 2층 복도를 살펴봅니다. 어둡고 긴 복도 끝에 안방 문이 보입니다. [서랍장]이 있습니다.", "system-msg");
                }
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색' 중 선택하십시오.");
            }
            return;
        }

        // [안방 클리어 후 탐색]
        if (gameState.phase === 'STORY_AFTER_ROOM2F') {
            if (!gameState.isWaitingForInput) return;
            const cmd = parseCommand(trimmed);
            if (gameState.waitingForCoatUser) {
                const target = gameState.party.find(p => p.name === trimmed && p.hp > 0);
                if (target) {
                    gameState.coatBonusPlayerId = target.id;
                    gameState.waitingForCoatUser = false;
                    broadcastRoomLog(roomId, `🧥 **[${target.name}]**이 코트를 걸쳤습니다.`, "heal-msg");
                    broadcastRoomState(roomId);
                }
                io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
                return;
            }

            if (cmd && cmd.action === 'LOOK') {
                broadcastRoomLog(roomId, "안방에는 **[옷장]**, **[화장대]**, **[서랍장]**이 보입니다.");
                io.to(roomId).emit('story_input_start', "▶ '탐색 [대상]' 중 선택하십시오.");
            } else if (cmd && cmd.action === 'SEARCH') {
                if (cmd.target === '옷장' && !gameState.room2fClosetSearched) {
                    gameState.room2fClosetSearched = true;
                    broadcastRoomLog(roomId, "🧥 **[두꺼운 코트]**를 발견했습니다! 누구에게 입히시겠습니까?", "heal-msg");
                    gameState.waitingForCoatUser = true;
                    io.to(roomId).emit('story_input_start', "▶ 코트를 입을 캐릭터의 이름을 입력하세요.");
                } else if (cmd.target === '화장대' && !gameState.room2fVanitySearched) {
                    gameState.room2fVanitySearched = true;
                    broadcastRoomLog(roomId, "🪞 거울 속에서 기괴한 원혼이 실체화됩니다!", "combat-msg");
                    gameState.enemies = [{ id: 'e_mirror', name: '거울', hp: 50, maxHp: 50, status: [] }];
                    gameState.phase = 'COMBAT';
                    gameState.returnPhase = 'STORY_AFTER_ROOM2F';
                    startCombatCycle(roomId);
                } else if (cmd.target === '서랍장' && !gameState.room2fInRoomDrawerSearched) {
                    gameState.room2fInRoomDrawerSearched = true;
                    broadcastRoomLog(roomId, "📜 서랍장에서 정체불명의 종이 조각을 발견했습니다. (최대 MP +10)", "heal-msg");
                    gameState.party.forEach(p => { p.maxMp = (p.maxMp || 100) + 10; p.mp += 10; });
                    broadcastRoomState(roomId);
                } else {
                    broadcastRoomLog(roomId, "조사할 대상을 선택하세요. (옷장, 화장대, 서랍장)");
                }
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
            } else if (trimmed === '이동 지하실' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 이동 지하실`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_BASEMENT_ENTRANCE';
                    gameState.location = '지하실 입구';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🏚️ 지하실 입구에 도착했습니다. 육중한 철문이 앞을 가로막습니다.", "system-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '진입', '대기', '탐색' 중 선택하십시오.");
                    }, 1500);
                }, 1000);
                return;
            } else if (trimmed === '개인정비' || (cmd && cmd.action === 'REST')) {
                if (!gameState.hasRested) {
                    gameState.hasRested = true;
                    gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + 25); p.mp = Math.min(p.maxMp || 100, p.mp + 25); });
                    broadcastRoomLog(roomId, "🍀 휴식을 취했습니다. (HP/MP +25)");
                    broadcastRoomState(roomId);
                }
            } else if (trimmed === '대기') {
                gameState.waitCount++;
                if (gameState.waitCount > 3) gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                broadcastRoomState(roomId);
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
            }
            return;
        }

        // [지하실 입구 선택지]
        if (gameState.phase === 'STORY_BASEMENT_ENTRANCE') {
            if (!gameState.isWaitingForInput) return;
            const cmd = parseCommand(trimmed);
            if (trimmed === '진입' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 진입`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'COMBAT';
                    gameState.enemies = [{ id: 'e6', name: '머리 없는 거구의 악귀', hp: 800, maxHp: 800, status: [], isCharging: false }];
                    broadcastRoomLog(roomId, "👹 머리 없는 거구의 악귀가 나타납니다!", "system-msg");
                    startCombatCycle(roomId);
                }, 1000);
            } else if (trimmed === '대기') {
                gameState.waitCount++;
                if (gameState.waitCount > 3) gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                broadcastRoomState(roomId);
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '진입', '대기', '탐색' 중 선택하십시오.");
            } else if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "🔦 철문 주변을 조사합니다. 불길한 기운이 감돕니다.");
                gameState.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '진입', '대기', '탐색' 중 선택하십시오.");
            }
            return;
        }

        // [지하실 입구 클리어 후 탐색]
        if (gameState.phase === 'STORY_AFTER_BASEMENT_ENTRANCE') {
            if (!gameState.isWaitingForInput) return;
            const cmd = parseCommand(trimmed);
            if (cmd && cmd.action === 'LOOK') {
                broadcastRoomLog(roomId, "주변에는 **[부서진 도끼]**와 **[고대의 제단]**이 보입니다.");
            } else if (cmd && cmd.action === 'SEARCH') {
                if (cmd.target === '부서진 도끼' && !gameState.demonAxeSearched) {
                    gameState.demonAxeSearched = true;
                    broadcastRoomLog(roomId, "🪓 부서진 도끼에서 영력을 채집했습니다. (강림 공격력 상승)", "heal-msg");
                    const kang = gameState.party.find(p => p.name === '강림');
                    if (kang) kang.bonusDmg = (kang.bonusDmg || 0) + 5;
                } else if (cmd.target === '고대의 제단' && !gameState.altarSearched) {
                    gameState.altarSearched = true;
                    gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp * 0.25)); p.mp = Math.min(p.maxMp || 100, p.mp + 25); });
                    broadcastRoomLog(roomId, "🍀 제단에서 빛이 뿜어져 나오며 파티를 치유합니다. (25% 회복)", "heal-msg");
                    broadcastRoomState(roomId);
                }
                io.to(roomId).emit('story_input_start', "▶ '이동 본당', '둘러보기', '탐색' 중 선택하십시오.");
            } else if (trimmed === '이동 본당' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 이동 본당`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_BASEMENT_CORE_ENTRY';
                    gameState.location = '지하실 본당';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🌑 본당에 들어서자 벽면에 붉은 한자들이 기괴하게 빛납니다.", "system-msg");
                    setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '문자를 확인한다' 라고 입력하십시오."); }, 1500);
                }, 1000);
            }
            return;
        }

        // [지하실 본당 진입 로직]
        if (gameState.phase === 'STORY_BASEMENT_CORE_ENTRY') {
            if (!gameState.isWaitingForInput) return;
            if (trimmed === '문자를 확인한다') {
                gameState.isWaitingForInput = false;
                const idioms = ["사불범정 만마항복 (邪不犯正 萬魔降伏)", "금성철벽 천라지망 (金城鐵壁 天羅地網)", "파사현정 명경지수 (破邪顯正 明경지수)", "권선징악 인과응보 (勸善懲惡 因果應報)"];
                idioms.sort(() => 0.5 - Math.random());
                broadcastRoomLog(roomId, "📜 벽면의 부정한 기운을 담은 글자들이 뒤섞입니다:", "system-msg");
                idioms.forEach(txt => broadcastRoomLog(roomId, `✨ ${txt}`, "guide-msg"));
                broadcastRoomLog(roomId, "정면에는 제단이 서있다. 다가가서 확인해보자.", "system-msg");
                setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '제단 확인' 이라고 입력하십시오."); }, 1000);
            } else if (trimmed === '제단 확인') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "😨 제단에 손을 올리자 본당 전체가 진동하며 태자귀가 소환됩니다!", "system-msg");
                setTimeout(() => {
                    gameState.phase = 'COMBAT';
                    gameState.enemies = [{ id: 'boss_final', name: '태자귀', hp: 2000, maxHp: 2000, status: [], gimmickPhase: 0 }];
                    startCombatCycle(roomId);
                }, 1500);
            }
            return;
        }
        io.to(roomId).emit('story_input_start', "▶ 명령을 입력하세요.");
    });

    socket.on('debug_skip', (target) => {
        const roomInfo = getSocketRoom(socket);
        if (!roomInfo) return;
        const { roomId, gameState } = roomInfo;
        console.log(`Debug skip triggered for room ${roomId}, target: ${target}`);

        // 스킵 시 게임이 아직 시작되지 않았다면 강제 시작 처리 (UI 전환용)
        if (!gameState.isStarted) {
            gameState.isStarted = true;
            io.to(roomId).emit('game_started');
            io.to(roomId).emit('lobby_update', gameState.clients, gameState.isStarted);
            broadcastRoomList();
        }

        if (target === 'hallway') {
            gameState.phase = 'STORY_HALLWAY';
            gameState.location = '1층 복도';
            gameState.isWaitingForInput = true;
            io.to(roomId).emit('location_update', gameState.location);
            io.to(roomId).emit('story_input_start', "▶ '전투 준비' 라고 명령하십시오.");
            broadcastRoomLog(roomId, "⏩ 1층 복도로 스킵했습니다.", "system-msg");
            broadcastRoomState(roomId);
        } else if (target === 'kitchen') {
            gameState.phase = 'STORY_KITCHEN_WAIT';
            gameState.location = '1층 주방 (식당)';
            gameState.isWaitingForInput = true;
            io.to(roomId).emit('location_update', gameState.location);
            io.to(roomId).emit('story_input_start', "▶ '전투 준비' 라고 명령하십시오.");
            broadcastRoomLog(roomId, "⏩ 주방 입구로 스킵했습니다.", "system-msg");
            broadcastRoomState(roomId);
        } else if (target === '2f') {
            gameState.phase = 'STORY_2F_HALLWAY';
            gameState.location = '2층 복도';
            gameState.isWaitingForInput = true;
            io.to(roomId).emit('location_update', gameState.location);
            io.to(roomId).emit('story_input_start', "▶ '이동 안방', '대기', '탐색' 중 선택하십시오.");
            broadcastRoomLog(roomId, "⏩ 2층 복도로 스킵했습니다.", "system-msg");
            broadcastRoomState(roomId);
        } else if (target === 'room2f_wait') {
            gameState.phase = 'STORY_AFTER_ROOM2F';
            gameState.location = '2층 안방';
            gameState.isWaitingForInput = true;
            io.to(roomId).emit('location_update', gameState.location);
            io.to(roomId).emit('story_input_start', "▶ '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
            broadcastRoomLog(roomId, "⏩ 안방 대기(클리어 후) 상태로 스킵했습니다.", "system-msg");
            broadcastRoomState(roomId);
        } else if (target === 'shrine') {
            gameState.phase = 'STORY_BASEMENT_CORE_ENTRY';
            gameState.location = '지하실 본당';
            gameState.isWaitingForInput = true;
            io.to(roomId).emit('location_update', gameState.location);
            io.to(roomId).emit('story_input_start', "▶ '문자를 확인한다' 라고 입력하십시오.");
            broadcastRoomLog(roomId, "⏩ 지하실 본당(사당)으로 스킵했습니다.", "system-msg");
            broadcastRoomState(roomId);
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

// Broadcast 헬퍼
function broadcastRoomState(roomId) {
    const room = rooms[roomId];
    if (room) io.to(roomId).emit('state_update', room.party, room.enemies, room.turnOwner, room.phase);
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
    if (!gs.incantationQueue || gs.incantationQueue.length === 0) {
        gs.incantationQueue = [...gs.party.filter(p => p.hp > 0)].sort(() => 0.5 - Math.random());
    }
    const actor = gs.incantationQueue.shift();
    gs.turnOwner = actor;
    gs.isWaitingForInput = true;
    broadcastRoomState(roomId);
    io.to(roomId).emit('turn_start', actor);
    broadcastRoomLog(roomId, `[영창] ${actor.name}의 차례입니다.`, "system-msg");
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
    const aliveEnemies = gameState.enemies.filter(e => e.hp > 0);
    const hasCharmed = gameState.party.some(p => p.status.includes('매혹'));

    if (aliveEnemies.length === 0) {
        if (gameState.phase === 'COMBAT') {
            gameState.party.forEach(p => p.status = []);
            gameState.turnOwner = null; // 전투 종료 시 턴 소유자 초기화
            broadcastRoomState(roomId);
            if (gameState.location === '1층 복도') {
                gameState.phase = 'STORY_AFTER_COMBAT';
                gameState.isWaitingForInput = true;
                broadcastRoomLog(roomId, "✅ 전투 종료! 앞을 가로막는 괴물이 모두 사라지고 건너편에는 주방이 보입니다. 주방으로 이동하시겠습니까?", "system-msg");
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
            } else if (gameState.location === '1층 주방 (식당)') {
                gameState.phase = gameState.returnPhase || 'STORY_AFTER_KITCHEN';
                gameState.returnPhase = null;
                gameState.isWaitingForInput = true;
                broadcastRoomLog(roomId, "✅ 전투 종료! 무엇을 진행하시겠습니까?", "system-msg");
                io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
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
                io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
            } else if (gameState.location === '지하실 입구') {
                gameState.phase = 'STORY_AFTER_BASEMENT_ENTRANCE';
                gameState.isWaitingForInput = true;
                broadcastRoomLog(roomId, "✅ 거구의 악귀를 쓰러뜨렸습니다! 철문 너머로 깊은 지하실 본당이 보입니다.", "system-msg");
                io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
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
                        io.to(roomId).emit('story_input_start', `▶ 같이 진행해온 이들의 이름을 입력하세요. (예: ${idList})`);
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
            setTimeout(() => nextTurn(roomId), 1500);
            return;
        }
        if (nextActor.status.includes('매혹') || nextActor.status.includes('혼란')) {
            setTimeout(() => {
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
                setTimeout(() => nextTurn(roomId), 1500);
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
                setTimeout(() => nextTurn(roomId), 1500);
                return;
            }
        }

        // [전투 종료 및 최종 엔딩 체크] - nextTurn 상단으로 로직 이동됨
        if (nextActor.mp < (nextActor.maxMp || 100)) {
            nextActor.mp = Math.min(nextActor.maxMp || 100, nextActor.mp + 3);
            broadcastRoomLog(roomId, `🍀 ${nextActor.name}의 MP가 자연적으로 회복됩니다. (+3)`, "guide-msg");
            broadcastRoomState(roomId);
        }
        gameState.isWaitingForInput = true;
        io.to(roomId).emit('turn_start', nextActor);
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
            setTimeout(() => nextTurn(roomId), 1500);
            return;
        }
        setTimeout(() => enemyAction(roomId, nextActor), 1500);
    }
}

function enemyAction(roomId, enemy) {
    const gameState = rooms[roomId];
    if (!gameState) return;
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
        setTimeout(() => nextTurn(roomId), 1500);
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
                setTimeout(() => nextTurn(roomId), 1000);
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
            setTimeout(() => nextTurn(roomId), 1000);
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
            setTimeout(() => nextTurn(roomId), 1000);
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
                setTimeout(() => nextTurn(roomId), 1000);
                return;
            }
            const dmg = 45;
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
                setTimeout(() => nextTurn(roomId), 1000);
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
                gs.isWaitingForInput = true;
                io.to(roomId).emit('story_input_start', "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                return; // 현재 턴 종료 후 탐색 모드로 대기
            }
        }
    }

    setTimeout(() => nextTurn(roomId), 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on ${PORT}`); });
