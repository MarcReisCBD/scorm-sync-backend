const ROOM_STATUS = {
  WAITING: 'waiting',
  CONTENT: 'content',
  SYNC: 'sync',
  VOTE: 'vote',
  RESULT: 'result',
  DEBATE: 'debate',
  PAUSED: 'paused',
  CLOSED: 'closed',
};

const VOTE_VALUES = ['A', 'B', 'C', 'D', 'E', 'F'];

const ROLES = {
  LEARNER:  'learner',
  TRAINER:  'trainer',
  DISPLAY:  'display',
};

module.exports = { ROOM_STATUS, VOTE_VALUES, ROLES };
