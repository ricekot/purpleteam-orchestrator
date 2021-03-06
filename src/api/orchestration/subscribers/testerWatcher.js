// Copyright (C) 2017-2021 BinaryMist Limited. All rights reserved.

// This file is part of purpleteam.

// purpleteam is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation version 3.

// purpleteam is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with purpleteam. If not, see <https://www.gnu.org/licenses/>.

const { promisify } = require('util');
const redis = require('redis');

let log;
let redisOptions;
let longPollTimeout;
// pub/sub (SSE)
let subscribeClients = {};
let nonBlockingClients = {};
// For queueing (which we use for long polling) as opposed to pub/sub (which we use for SSE):
//   If non blocking redis commands are used on a redis client that isn't using blocking commands, the non-blocking commands may be queued up until after the blocking ones finish.
//   So we use client instances that will be used for blocking commands only.
let blockingClients = {};

const subscribe = (redisChannel, callback) => {
  subscribeClients[redisChannel] = redis.createClient(redisOptions);
  subscribeClients[redisChannel].subscribe(redisChannel);

  subscribeClients[redisChannel].on('error', (error) => {
    log.error(`Redis error: ${error}`, { tags: ['testerWatcher'] });
  });

  subscribeClients[redisChannel].on('message', callback);
};

const getTesterMessages = async (redisList) => {
  // If list has > 0 items, we want to return as many as there are now.
  // If list has 0 items, we want to wait until it has at least one item, then return it.
  const llen = promisify(nonBlockingClients[redisList].llen).bind(nonBlockingClients[redisList]);
  const lpop = promisify(nonBlockingClients[redisList].lpop).bind(nonBlockingClients[redisList]);
  const blpop = promisify(blockingClients[redisList].blpop).bind(blockingClients[redisList]);
  const curListLen = await llen(redisList).catch((e) => { log.error(`Error occurred while attempting to get list length of list "${redisList}". Error was: ${e}`, { tags: ['testerWatcher'] }); });
  let testerMessageSet = [];
  if (curListLen > 0) {
    const testerMessageSetOfPromises = [];
    const handleLpopError = (e) => { log.error(`Error occurred while attempting to lpop list "${redisList}". Error was: ${e}`, { tags: ['testerWatcher'] }); };
    for (let i = 0; i < curListLen; i += 1) {
      testerMessageSetOfPromises.push(lpop(redisList).catch(handleLpopError));
    }
    testerMessageSet = await Promise.all(testerMessageSetOfPromises).catch((e) => { log.error(`Error occurred while attempting to resolve testerMessageSetOfPromises lpop'ed from list "${redisList}". Error was: ${e}`, { tags: ['testerWatcher'] }); });
  } else { // Wait...
    // blpop's resolved promise could be one of two things (https://redis.io/commands/blpop#return-value):
    // 1. If it times out: An array with one element being null.
    // 2. If a value becomes available: An array with two elements. First being the key name of the list. Second being the value lpoped (popped from the head) from the list.
    // After cleanUpAfterTestRun has been executed, the clients will no longer exist, so calls to blpop will resolve to just null.
    const multiBulk = await blpop(redisList, longPollTimeout).catch((e) => { log.error(`Error occurred while attempting to blpop list "${redisList}". Error was: ${e}`, { tags: ['testerWatcher'] }); });
    testerMessageSet.push((multiBulk && multiBulk[0] !== null) /* must be the name of the key where an element was popped (I.E. the name of our channel and list) */ ? multiBulk[1] : null);
  }
  return testerMessageSet;
};

const pollTesterMessages = async (redisChannel, callback) => {
  const redisList = redisChannel;
  // Only do the subscription once for each channel.
  if (!subscribeClients[redisChannel]) {
    nonBlockingClients[redisList] = redis.createClient(redisOptions);
    blockingClients[redisList] = redis.createClient(redisOptions);
    subscribe(redisChannel, (channel, message) => {
      // Push message to list with same name as channel.
      nonBlockingClients[channel].rpush(redisList, message);
    });
  }

  // Here is where we block and wait for our list to contain messages,
  //   then build a reponse array for the given list, pass each message into callback,
  //   callback also contains a reference to cleanUpAfterTestRun,
  //   then return the CLI ready set of messages.
  const testerMessageSet = await getTesterMessages(redisList);

  const cliAfiedTesterMessageSet = testerMessageSet.map((tM) => callback(redisChannel, tM));
  return cliAfiedTesterMessageSet;
};

const cleanUpAfterTestRun = () => {
  // Will need to cleanup subscribeClients.
  Object.values(subscribeClients).forEach((c) => { c.unsubscribe(); c.quit(); });
  Object.values(nonBlockingClients).forEach((c) => { c.quit(); });
  Object.values(blockingClients).forEach((c) => { c.quit(); });
  subscribeClients = {};
  nonBlockingClients = {};
  blockingClients = {};
};

const serverStart = (options) => {
  ({ log, redis: redisOptions, longPollTimeout } = options);
  const { testerFeedbackCommsMedium } = options;
  return { lp: { pollTesterMessages, cleanUpAfterTestRun }, sse: { subscribe, cleanUpAfterTestRun } }[testerFeedbackCommsMedium];
};


module.exports = {
  subscribe,
  pollTesterMessages,
  cleanUpAfterTestRun,
  serverStart
};


// Test Job Channels:
//  app-lowPrivUser -> list
//  app-adminUser   -> list
//  server-NA       -> list
//  tls-NA          -> list

// events
//  'testerProgress'
//  'testerPctComplete'
//  'testerBugCount'
