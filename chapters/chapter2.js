/**
 * 챕터 2: [제목 미정] (Scenario Module Skeleton)
 */

module.exports = {
    id: 'chapter2',
    name: '챕터 2 (개발 중)',

    getInitialState: () => ({
        location: '새로운 지역 입구',
        phase: 'STORY_INTRO',
        // 챕터 2 전용 상태들...
    }),

    handleInput: (socket, roomId, gameState, nickname, trimmed, helpers) => {
        const { io, broadcastRoomLog, syncInputState } = helpers;

        if (gameState.phase === 'STORY_INTRO') {
            if (trimmed === '진입') {
                broadcastRoomLog(roomId, "새로운 전설이 시작됩니다...", "system-msg");
                // 로직 구현...
            }
            return true;
        }

        return false;
    },

    getPlaceholder: (gameState) => {
        if (gameState.phase === 'STORY_INTRO') return "▶ '진입'을 입력하여 챕터 2를 시작하세요.";
        return null;
    },

    handleDebugSkip: (io, roomId, gameState, target, helpers) => {
        return false;
    }
};
