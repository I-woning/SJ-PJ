const chapter1 = require('./chapter1');
const chapter2 = require('./chapter2');

const chapters = {
    'chapter1': chapter1,
    'chapter2': chapter2
};

module.exports = {
    all: chapters,
    get: (id) => chapters[id] || chapter1 // 기본값 챕터1
};
