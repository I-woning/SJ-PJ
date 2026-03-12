/**
 * 챕터 1: 흑주택 토벌작전 (Scenario Module)
 */

module.exports = {
    id: 'chapter1',
    name: '흑주택 토벌작전',

    // 챕터 시작 시의 초기 상태 정의
    getInitialState: () => ({
        location: '흑주택 현관 전',
        phase: 'STORY_ENTRANCE',
        waitCount: 0,
        hasRested: false,
        demonAxeSearched: false,
        altarSearched: false,
        poltergeistState: { hiddenSpot: null, hasRehidden: false, lookCount: 0 },
        isMirrorGlitchActive: false,
        room2fDrawerSearched: false,
        room2fClosetSearched: false,
        room2fVanitySearched: false,
        room2fInRoomDrawerSearched: false,
        waitingForCoatUser: false,
        coatBonusPlayerId: null,
        fridgeSearched: false,
        drawerSearched: false,
        completedIndices: [],
        incantationIndex: 0,
        currentIncantation: ""
    }),

    // 챕터별 인트로 실행
    startIntro: (io, roomId, gameState) => {
        const broadcastRoomLog = (rId, msg, cls) => io.to(rId).emit('chat_message', { sender: 'SYSTEM', msg, type: cls || 'system' });
        
        broadcastRoomLog(roomId, "검은 안개에 휩싸인 '흑주택'의 육중한 담장 앞에 도착했습니다.", "system-msg");
        broadcastRoomLog(roomId, "비릿한 피 냄새와 서늘한 냉기가 저택 틈새로 흘러나오는 것이 느껴집니다.");
        broadcastRoomLog(roomId, "결계를 깨고 진입하면 소멸하지 않는 이상 되돌아갈 수 없습니다. 준비가 되었습니까?");
        
        gameState.isWaitingForInput = true;
        
        // 입력 가이드 전송 (placeholder)
        io.to(roomId).emit('story_input_start', "▶ '진입' 이라고 명령하십시오.");
    },

    // 챕터 전용 입력 처리 (server.js의 user_input에서 이관)
    handleInput: (socket, roomId, gameState, nickname, trimmed, helpers) => {
        const { io, broadcastRoomLog, broadcastRoomState, syncInputState, startCombatCycle, startIncantationTurn, startEnding, parseCommand, executePlayerAction, nextTurn, safeNextTurn } = helpers;

        // [전멸: 로비 복귀 처리] - 엔진 공통으로 둘 수도 있지만 일단 챕터에 둠
        if (gameState.phase === 'GAMEOVER') {
            if (trimmed === '로비로 돌아가기') {
                helpers.resetToLobby(roomId);
            }
            return true; 
        }

        // 1. 현관 진입
        if (gameState.phase === 'STORY_ENTRANCE') {
            if (!gameState.isWaitingForInput) return true;
            if (trimmed === '진입') {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_HALLWAY';
                    gameState.location = '1층 복도';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "끼이익... 무거운 나무문이 열립니다.", "system-msg");
                    broadcastRoomLog(roomId, "1층 복도는 칠흑같이 어둡습니다. 벽에는 누군가 긁어놓은 듯한 손톱자국이 가득합니다.");
                    broadcastRoomLog(roomId, "...그때, 어둠 속에서 붉은 안광 두 짝이 번쩍입니다!");
                    broadcastRoomLog(roomId, "기괴한 울음소리를 내는 '짐승령'과 바닥을 기어오는 '하급 지박령'이 길을 막습니다.");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        syncInputState(roomId, "▶ '전투 준비' 라고 명령하십시오.");
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
            } else {
                io.to(roomId).emit('story_input_start', "▶ '진입' 이라고 정확히 입력하십시오.");
            }
            return true;
        }

        // 2. 복도 전투 돌입
        if (gameState.phase === 'STORY_HALLWAY') {
            if (!gameState.isWaitingForInput) return true;
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
                syncInputState(roomId, "▶ '전투 준비' 라고 명령하십시오.");
            } else {
                syncInputState(roomId, "▶ '전투 준비' 라고 정확히 입력하십시오.");
            }
            return true;
        }

        // 3. 복도 클리어 후 선택지
        if (gameState.phase === 'STORY_AFTER_COMBAT') {
            if (!gameState.isWaitingForInput) return true;
            const cmd = parseCommand(trimmed);
            if (trimmed === '대기') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
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
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (trimmed === '개인정비' || (cmd && cmd.action === 'REST')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 개인정비`, "user-cmd-msg");
                if (gameState.hasRested) {
                    broadcastRoomLog(roomId, "이미 주변의 쓸만한 물품을 다 사용하여 더 이상 정비할 수 없습니다.");
                } else {
                    gameState.hasRested = true;
                    broadcastRoomLog(roomId, "파티원들이 잠시 숨을 고르며 전열을 가가듬습니다.");
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
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: 탐색`, "user-cmd-msg");
                broadcastRoomLog(roomId, "🔦 복도를 훑어봅니다. 벽면에는 마르지 않은 핏자국이 기괴한 무늬를 그리며 흘러내리고 있고, 낡은 벽지 뒤로 빛바랜 부적의 흔적들이 보입니다. 건물이 누군가를 가두기 위해 설계된 것 같은 불길한 느낌이 듭니다.", "system-msg");
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (trimmed === '이동' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
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
                        syncInputState(roomId, "▶ '전투 준비' 라고 명령하십시오.");
                    }, 1500);
                }, 1000);
            } else {
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색', '개인정비' 중 선택하십시오.");
            }
            return true;
        }

        // 4. 주방 전투 준비
        if (gameState.phase === 'STORY_KITCHEN_WAIT') {
            if (!gameState.isWaitingForInput) return true;
            if (trimmed === '전투 준비') {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_KITCHEN_FIND';
                    broadcastRoomLog(roomId, "⚔️ 폴터가이스트와의 전투가 시작됩니다! 본체를 찾아내야 합니다!", "system-msg");
                    broadcastRoomLog(roomId, "💡 적의 모습이 보이지 않습니다! (명령어 '둘러보기' 혹은 '탐색' 필요)", "guide-msg");
                    const spots = ['냉장고', '싱크대', '가스레인지', '전자레인지', '서랍장', '식탁'];
                    gameState.poltergeistState = { hiddenSpot: spots[Math.floor(Math.random() * spots.length)], hasRehidden: false, lookCount: 0 };
                    gameState.isWaitingForInput = true;
                    syncInputState(roomId, "▶ '둘러보기' 명령어를 입력하여 주변 사물을 확인하세요.");
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
                syncInputState(roomId, "▶ '전투 준비' 라고 명령하십시오.");
            } else {
                syncInputState(roomId, "▶ '전투 준비' 라고 정확히 입력하십시오.");
            }
            return true;
        }

        // 5. 주방 본체 찾기 전용 페이즈
        if (gameState.phase === 'STORY_KITCHEN_FIND') {
            if (!gameState.isWaitingForInput) return true;
            const cmd = parseCommand(trimmed);
            if (trimmed !== '대기') gameState.waitCount = 0;

            if (trimmed === '대기') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) {
                    broadcastRoomLog(roomId, "다리가 저려옵니다. 정신력이 감소합니다.", "system-msg");
                    gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                    broadcastRoomLog(roomId, `😱 파티 전원의 MP가 5 감소했습니다!`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, "투명한 공포 속에 몸을 떨며 주변을 살핍니다.", "system-msg");
                }
                broadcastRoomState(roomId);
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    syncInputState(roomId, "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                }, 1000);
            } else if (cmd.action === 'LOOK') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                gameState.poltergeistState.lookCount++;
                if (gameState.poltergeistState.lookCount === 1) {
                    broadcastRoomLog(roomId, "🔍 주방 한켠에 **[냉장고]**, **[싱크대]**, **[가스레인지]**가 보입니다. 더 둘러보시겠습니까? 아니면 탐색해보시겠습니까?", "guide-msg");
                } else {
                    broadcastRoomLog(roomId, "🔍 주방 다른 한켠에 **[전자레인지]**, **[서랍장]**, **[식탁]**이 보입니다. 이제 의심되는 곳을 탐색해보십시오!", "guide-msg");
                }
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    syncInputState(roomId, "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                }, 1000);
            } else if (cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어] 파티 행동</span>: ${trimmed}`, "user-cmd-msg");
                if (!cmd.target || cmd.target === 'NONE' || cmd.target.trim() === '') {
                    broadcastRoomLog(roomId, "무엇을 탐색할 지 몰라 허둥지둥 댑니다.", "guide-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        syncInputState(roomId, "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                    }, 1000);
                    return true;
                }
                if (cmd.target === gameState.poltergeistState.hiddenSpot) {
                    gameState.phase = 'COMBAT';
                    let polter = gameState.enemies.find(e => e.name === '굶주린 폴터가이스트');
                    if (polter) polter.status = polter.status.filter(s => s !== '은신');
                    else gameState.enemies = [{ id: 'e3', name: '굶주린 폴터가이스트', hp: 120, maxHp: 120, status: [] }];
                    broadcastRoomLog(roomId, `✨ 찾았다! **[${cmd.target}]** 속에 숨어있던 폴터가이스트가 모습을 드러냅니다!`, "system-msg");
                    startCombatCycle(roomId);
                } else {
                    broadcastRoomLog(roomId, `💨 **[${cmd.target}]**에는 아무것도 없었습니다...`, "combat-msg");
                    const alive = gameState.party.filter(p => p.hp > 0);
                    const t = alive[Math.floor(Math.random() * alive.length)];
                    t.hp = Math.max(0, t.hp - 15);
                    broadcastRoomLog(roomId, `😨 정적을 깨고 폴터가이스트가 기습합니다! ${t.name}에게 15 피해!`, "combat-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        syncInputState(roomId, "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
                        broadcastRoomState(roomId);
                    }, 1000);
                }
            } else {
                syncInputState(roomId, "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요.");
            }
            return true;
        }

        // 6. 전투 모드 (공통 엔진이 처리하지만 특수 기믹 위임 가능)
        if (gameState.phase === 'COMBAT') {
            if (!gameState.isWaitingForInput) return true;
            if (!gameState.turnOwner) return true;
            const isPartyTurn = gameState.party.some(p => p.id === gameState.turnOwner.id);
            if (!isPartyTurn) return true;
            
            const cmd = parseCommand(trimmed);
            if (!cmd || cmd.action === 'UNKNOWN') {
                socket.emit('game_error', '올바른 전투 명령을 입력하세요. (공격, 스킬, 방어, 둘러보기, 탐색)');
                return true;
            }

            gameState.isWaitingForInput = false;
            io.to(roomId).emit('turn_wait');
            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span> <b>${gameState.turnOwner.name}</b>: ${trimmed}`, "user-cmd-msg");
            executePlayerAction(roomId, gameState.turnOwner, cmd, socket);
            return true;
        }

        // 7. 영창 모드 (챕터 전용 핵심 기믹)
        if (gameState.phase === 'INCANTATION') {
            if (!gameState.isWaitingForInput) return true;
            const owner = gameState.turnOwner;
            if (!owner) return true;

            gameState.isWaitingForInput = false;
            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span> <b>${owner.name}</b>: ${trimmed}`, "user-cmd-msg");

            const expectedIncantation = gameState.currentIncantation;
            const charMap = { '무당': [0, 4], '퇴마사': [1, 5], '영매': [2, 6], '사제': [3, 7] };
            const myIndices = charMap[owner.job] || [];
            const correctIndex = myIndices.find(idx => expectedIncantation[idx] === trimmed);

            if (correctIndex !== undefined) {
                if (!gameState.completedIndices) gameState.completedIndices = [];
                if (gameState.completedIndices.includes(correctIndex)) {
                    broadcastRoomLog(roomId, `‼️ **이미 외친 글자입니다!** (${trimmed})`, "combat-msg");
                } else {
                    broadcastRoomLog(roomId, `✨ **정확합니다!** ${owner.name}의 외침이 공명합니다. (${trimmed})`, "heal-msg");
                    gameState.completedIndices.push(correctIndex);
                    gameState.incantationIndex++;

                    if (gameState.incantationIndex >= expectedIncantation.length) {
                        gameState.phase = 'COMBAT';
                        const boss = gameState.enemies.find(e => e.name === '태자귀');
                        boss.status.push('기절');
                        broadcastRoomLog(roomId, "✨ **영창 성공!** 강력한 신성력이 태자귀를 억누릅니다! (2턴 간 기절)", "heal-msg");
                        gameState.completedIndices = [];
                        io.to(roomId).emit('turn_wait');
                        setTimeout(() => startCombatCycle(roomId), 1500);
                    } else {
                        setTimeout(() => startIncantationTurn(roomId), 1000);
                    }
                    return true;
                }
            }

            // 실패 처리
            gameState.phase = 'COMBAT';
            gameState.completedIndices = [];
            const boss = gameState.enemies.find(e => e.name === '태자귀');
            if (boss.gimmickPhase === 1 || boss.gimmickPhase === 3) {
                broadcastRoomLog(roomId, "‼️ **영창 실패!** 흐트러진 주문의 기운이 파티를 덮칩니다!", "combat-msg");
                gameState.party.forEach(p => { if (p.job !== '사제') p.status.push(['매혹', '공포', '기절'][Math.floor(Math.random()*3)]); });
            } else {
                const healAmt = Math.floor(boss.maxHp * 0.1);
                boss.hp = Math.min(boss.maxHp, boss.hp + healAmt);
                broadcastRoomLog(roomId, `‼️ **영창 실패!** 태자귀가 상처를 회복합니다! (+${healAmt} HP)`, "combat-msg");
            }
            boss.gimmickPhase = Math.max(0, boss.gimmickPhase - 1);
            broadcastRoomState(roomId);
            io.to(roomId).emit('turn_wait');
            setTimeout(() => startCombatCycle(roomId), 1500);
            return true;
        }

        // 8. 최종 엔딩: ID 검증 모드
        if (gameState.phase === 'FINAL_ID_CHECK') {
            if (!gameState.isWaitingForInput) return true;
            broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: ${trimmed}`, "user-cmd-msg");
            const requiredIds = gameState.clients.map(c => c.nickname).sort().join(',');
            const inputIds = trimmed.split(',').map(s => s.trim()).sort().join(',');

            if (requiredIds === inputIds) {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "✨ **진실의 목소리**: 환상이 깨지며 동료들의 온기가 선명해집니다.", "heal-msg");
                setTimeout(() => startEnding(roomId), 2000);
            } else {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "🌑 **태자귀**: \"후후... 가엾은 것... 환상 속에서 영원히 헤매이거라.\"", "combat-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_BASEMENT_CORE_ENTRY';
                    gameState.location = '지하실 본당';
                    gameState.enemies = [];
                    io.to(roomId).emit('restore_ui');
                    broadcastRoomLog(roomId, "⏳ 시간과 공간이 뒤틀리며 다시 본당 입구로 돌아왔습니다.", "system-msg");
                    broadcastRoomState(roomId);
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        syncInputState(roomId, "▶ '문자를 확인한다' 라고 입력하십시오.");
                    }, 1500);
                }, 2000);
            }
            return true;
        }

        // 9. 주방 클리어 후
        if (gameState.phase === 'STORY_AFTER_KITCHEN') {
            if (!gameState.isWaitingForInput) return true;
            const cmd = parseCommand(trimmed);
            if (trimmed === '대기') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 대기`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                broadcastRoomState(roomId);
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (trimmed === '개인정비' || (cmd && cmd.action === 'REST')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 개인정비`, "user-cmd-msg");
                if (!gameState.hasRested) {
                    gameState.hasRested = true;
                    gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp*0.15)); p.mp = Math.min(p.maxMp||100, p.mp + 15); });
                    broadcastRoomLog(roomId, "🍀 정비를 진행했습니다. (HP/MP +15%)", "heal-msg");
                    broadcastRoomState(roomId);
                } else broadcastRoomLog(roomId, "이미 정비를 마쳤습니다.");
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                if (cmd.target === '냉장고' && !gameState.fridgeSearched) {
                    gameState.fridgeSearched = true;
                    broadcastRoomLog(roomId, "✨ 냉장고에서 신선한 재료를 찾아냈습니다! (HP/MP 고속 회복)", "heal-msg");
                    gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + 30); p.mp = Math.min(p.maxMp||100, p.mp + 30); });
                    broadcastRoomState(roomId);
                } else if (cmd.target === '서랍장' && !gameState.drawerSearched) {
                    gameState.drawerSearched = true;
                    broadcastRoomLog(roomId, "📜 서랍장에서 잃어버린 기억의 파편을 찾았습니다. (최대 MP +10)", "heal-msg");
                    gameState.party.forEach(p => { p.maxMp = (p.maxMp||100) + 10; p.mp += 10; });
                    broadcastRoomState(roomId);
                } else broadcastRoomLog(roomId, "주방에는 **[냉장고]**와 **[서랍장]**이 보입니다.");
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
            } else if (trimmed === '이동 2층' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                gameState.waitCount = 0;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 이동 2층`, "user-cmd-msg");
                setTimeout(() => {
                    gameState.phase = 'STORY_2F_HALLWAY';
                    gameState.location = '2층 복도';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🕯️ 복도 끝 안방 문 틈으로 보랏빛 안개가 흘러나오고 있습니다.", "system-msg");
                    setTimeout(() => {
                        gameState.isWaitingForInput = true;
                        io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색' 중 선택하십시오.");
                    }, 1500);
                }, 1000);
            } else {
                io.to(roomId).emit('story_input_start', "▶ '이동 2층', '대기', '탐색', '개인정비' 중 선택하십시오.");
            }
            return true;
        }

        // 10. 2층 복도 (생략 가능하지만 추출)
        if (gameState.phase === 'STORY_2F_HALLWAY') {
            if (!gameState.isWaitingForInput) return true;
            const cmd = parseCommand(trimmed);
            if (trimmed === '이동 안방' || trimmed === '이동' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 이동 안방`, "user-cmd-msg");
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
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                if (!gameState.room2fDrawerSearched) {
                    gameState.room2fDrawerSearched = true;
                    broadcastRoomLog(roomId, "📜 서랍장에서 고문서를 읽고 정신력이 고양됩니다. (최대 MP +10)", "heal-msg");
                    gameState.party.forEach(p => { p.maxMp = (p.maxMp||100) + 10; p.mp += 10; });
                } else broadcastRoomLog(roomId, "이미 탐색한 서랍장입니다.");
                broadcastRoomState(roomId);
                setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색' 중 선택하십시오."); }, 1000);
            } else {
                io.to(roomId).emit('story_input_start', "▶ '이동', '대기', '탐색' 중 선택하십시오.");
            }
            return true;
        }

        // 11. 안방 클리어 후
        if (gameState.phase === 'STORY_AFTER_ROOM2F') {
            if (!gameState.isWaitingForInput) return true;
            const cmd = parseCommand(trimmed);
            if (trimmed === '대기' || (cmd && cmd.action === 'WAIT')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 대기`, "user-cmd-msg");
                gameState.waitCount++;
                if (gameState.waitCount > 3) gameState.party.forEach(p => p.mp = Math.max(0, p.mp - 5));
                broadcastRoomState(roomId);
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
                return true;
            } else if (trimmed === '개인정비' || (cmd && cmd.action === 'REST')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                broadcastRoomLog(roomId, `> <span style="color:#f5c518; font-size:0.8rem;">[${nickname} 제어]</span>: 개인정비`, "user-cmd-msg");
                if (!gameState.hasRested) {
                    gameState.hasRested = true;
                    gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp*0.15)); p.mp = Math.min(p.maxMp||100, p.mp + 15); });
                    broadcastRoomLog(roomId, "🍀 정비를 진행했습니다. (HP/MP +15%)", "heal-msg");
                    broadcastRoomState(roomId);
                } else broadcastRoomLog(roomId, "이미 정비를 마쳤습니다.");
                setTimeout(() => {
                    gameState.isWaitingForInput = true;
                    io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오.");
                }, 1000);
                return true;
            }

            if (gameState.waitingForCoatUser) {
                const target = gameState.party.find(p => p.name === trimmed && p.hp > 0);
                if (target) {
                    gameState.coatBonusPlayerId = target.id;
                    gameState.waitingForCoatUser = false;
                    broadcastRoomLog(roomId, `🧥 **[${target.name}]**이 코트를 걸쳤습니다.`, "heal-msg");
                    broadcastRoomState(roomId);
                    setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오."); }, 1000);
                } else io.to(roomId).emit('story_input_start', "▶ 이름을 정확히 입력하세요.");
                return true;
            }
            if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                if (cmd.target === '옷장' && !gameState.room2fClosetSearched) {
                    gameState.room2fClosetSearched = true;
                    broadcastRoomLog(roomId, "🧥 **[두꺼운 코트]**를 발견했습니다! 누구에게 입히시겠습니까?", "heal-msg");
                    gameState.waitingForCoatUser = true;
                    io.to(roomId).emit('story_input_start', "▶ 코트를 입을 캐릭터의 이름을 입력하세요.");
                } else if (cmd.target === '화장대' && !gameState.room2fVanitySearched) {
                    gameState.room2fVanitySearched = true;
                    broadcastRoomLog(roomId, "🪞 거울 속에서 원혼이 튀어 나옵니다!", "combat-msg");
                    gameState.enemies = [{ id: 'e_mirror', name: '거울', hp: 50, maxHp: 50, status: [] }];
                    gameState.phase = 'COMBAT';
                    gameState.returnPhase = 'STORY_AFTER_ROOM2F';
                    startCombatCycle(roomId);
                } else broadcastRoomLog(roomId, "안방에는 **[옷장]**, **[화장대]**, **[서랍장]**이 보입니다.");
                setTimeout(() => { if (gameState.phase !== 'COMBAT') { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', gameState.waitingForCoatUser ? "▶ 코트를 입을 캐릭터의 이름을 입력하세요." : "▶ '이동', '둘러보기', '탐색', '개인정비' 중 선택하십시오."); } }, 1000);
            } else if (trimmed === '이동 지하실' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                setTimeout(() => {
                    gameState.phase = 'STORY_BASEMENT_ENTRANCE';
                    gameState.location = '지하실 입구';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🏚️ 지하실 입구의 육중한 철문이 앞을 가로막습니다.", "system-msg");
                    setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '진입', '대기', '탐색' 중 선택하십시오."); }, 1500);
                }, 1000);
            } else {
                io.to(roomId).emit('story_input_start', "▶ '이동', '둘러보기', '탐색' 중 선택하십시오.");
            }
            return true;
        }

        // 12. 지하실 입구
        if (gameState.phase === 'STORY_BASEMENT_ENTRANCE') {
            if (!gameState.isWaitingForInput) return true;
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
            } else if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "🔦 철문 주변을 조사합니다. 불길한 기운이 감돕니다.");
                setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '진입', '대기', '탐색' 중 선택하십시오."); }, 1000);
            } else {
                io.to(roomId).emit('story_input_start', "▶ '진입', '대기', '탐색' 중 선택하십시오.");
            }
            return true;
        }

        // 13. 지하실 입구 클리어 후
        if (gameState.phase === 'STORY_AFTER_BASEMENT_ENTRANCE') {
            if (!gameState.isWaitingForInput) return true;
            const cmd = parseCommand(trimmed);
            if (cmd && cmd.action === 'SEARCH') {
                gameState.isWaitingForInput = false;
                if (cmd.target === '부서진 도끼' && !gameState.demonAxeSearched) {
                    gameState.demonAxeSearched = true;
                    broadcastRoomLog(roomId, "🪓 부서진 도끼에서 영력을 채집했습니다. (강림 공격력 상승)", "heal-msg");
                    const kang = gameState.party.find(p => p.name === '강림');
                    if (kang) kang.bonusDmg = (kang.bonusDmg || 0) + 5;
                } else if (cmd.target === '고대의 제단' && !gameState.altarSearched) {
                    gameState.altarSearched = true;
                    gameState.party.forEach(p => { p.hp = Math.min(p.maxHp, p.hp + Math.floor(p.maxHp * 0.25)); p.mp = Math.min(p.maxMp||100, p.mp + 25); });
                    broadcastRoomLog(roomId, "🍀 제단이 파티를 치유합니다. (25% 회복)", "heal-msg");
                    broadcastRoomState(roomId);
                } else broadcastRoomLog(roomId, "주변에는 **[부서진 도끼]**와 **[고대의 제단]**이 보입니다.");
                setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '이동 본당', '탐색', '개인정비' 중 선택하십시오."); }, 1000);
            } else if (trimmed === '이동 본당' || (cmd && cmd.action === 'MOVE')) {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                setTimeout(() => {
                    gameState.phase = 'STORY_BASEMENT_CORE_ENTRY';
                    gameState.location = '지하실 본당';
                    io.to(roomId).emit('location_update', gameState.location);
                    broadcastRoomLog(roomId, "🌑 본당 벽면에 붉은 한자들이 기괴하게 빛납니다.", "system-msg");
                    setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '문자를 확인한다' 라고 입력하십시오."); }, 1500);
                }, 1000);
            } else {
                io.to(roomId).emit('story_input_start', "▶ '이동 본당', '탐색', '개인정비' 중 선택하십시오.");
            }
            return true;
        }

        // 14. 지하실 본당 진입 로직
        if (gameState.phase === 'STORY_BASEMENT_CORE_ENTRY') {
            if (!gameState.isWaitingForInput) return true;
            if (trimmed === '문자를 확인한다') {
                gameState.isWaitingForInput = false;
                io.to(roomId).emit('turn_wait');
                const idioms = ["사불범정 만마항복 (邪不犯正 萬魔降伏)", "금성철벽 천라지망 (金城鐵壁 天羅地網)", "파사현정 명경지수 (破邪顯正 明경지수)", "권선징악 인과응보 (勸善懲惡 因果應報)"];
                idioms.sort(() => 0.5 - Math.random());
                broadcastRoomLog(roomId, "📜 벽면의 글자들이 뒤섞입니다:", "system-msg");
                idioms.forEach(txt => broadcastRoomLog(roomId, `✨ ${txt}`, "guide-msg"));
                broadcastRoomLog(roomId, "정면의 제단에 다가가서 확인해보십시오.", "system-msg");
                setTimeout(() => { gameState.isWaitingForInput = true; io.to(roomId).emit('story_input_start', "▶ '제단 확인' 이라고 입력하십시오."); }, 1000);
            } else if (trimmed === '제단 확인') {
                gameState.isWaitingForInput = false;
                broadcastRoomLog(roomId, "😨 제단에 손을 올리자 본당 전체가 진동하며 태자귀가 소환됩니다!", "system-msg");
                setTimeout(() => {
                    gameState.phase = 'COMBAT';
                    gameState.enemies = [{ id: 'boss_final', name: '태자귀', hp: 1500, maxHp: 1500, status: [], gimmickPhase: 0 }];
                    startCombatCycle(roomId);
                }, 1000);
            } else syncInputState(roomId, "▶ '문자를 확인한다' 혹은 '제단 확인' 이라고 입력하십시오.");
            return true;
        }

        return false; // 이 챕터에서 처리하지 않은 페이즈
    },

    // 챕션 전용 가이드 메시지 (syncInputState에서 이관)
    getPlaceholder: (gameState) => {
        const ph = {
            'STORY_ENTRANCE': "▶ '진입' 혹은 '대기'를 입력하십시오.",
            'STORY_KITCHEN_FIND': "▶ '둘러보기' 혹은 '탐색 [장소]'를 입력하세요."
        };
        return ph[gameState.phase] || null;
    },

    // 챕터 전용 디버그 스킵 처리
    handleDebugSkip: (io, roomId, gameState, target, helpers) => {
        const { broadcastRoomLog, broadcastRoomState, syncInputState } = helpers;
        const jumps = {
            'hallway': { phase: 'STORY_HALLWAY', loc: '1층 복도', msg: "⏪ 1층 복도로 스킵했습니다.", prompt: "▶ '전투 준비' 라고 명령하십시오." },
            'kitchen': { phase: 'STORY_KITCHEN_WAIT', loc: '1층 주방 (식당)', msg: "⏪ 주방 입구로 스킵했습니다.", prompt: "▶ '전투 준비' 라고 명령하십시오." },
            '2f': { phase: 'STORY_2F_HALLWAY', loc: '2층 복도', msg: "⏪ 2층 복도로 스킵했습니다.", prompt: "▶ '이동 안방', '대기', '탐색' 중 선택하십시오." },
            'shrine': { phase: 'STORY_BASEMENT_CORE_ENTRY', loc: '지하실 본당', msg: "⏪ 지하실 본당으로 스킵했습니다.", prompt: "▶ '문자를 확인한다' 라고 입력하십시오." }
        };
        const jump = jumps[target];
        if (jump) {
            gameState.phase = jump.phase;
            gameState.location = jump.loc;
            gameState.isWaitingForInput = true;
            io.to(roomId).emit('location_update', gameState.location);
            broadcastRoomLog(roomId, jump.msg, "system-msg");
            broadcastRoomState(roomId);
            syncInputState(roomId, jump.prompt);
            return true;
        }
        return false;
    }
};
