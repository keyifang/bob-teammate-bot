// Task routing: which model answers.
//
// WHY THIS EXISTS
//
// Bob is two different jobs. Chatting in a group is latency-sensitive - the
// experience IS the speed - while researching or drafting is not, and wants a
// stronger model. Sending everything to one model means paying reasoning-model
// latency for "ok cool" and paying model fragility for a proposal.
//
// MEASURED (4 calls each, same conversational prompt, corrected probe):
//   nvidia/nemotron-3.5-lightning:free       5.0s 1.4s 3.0s 4.8s  -> 4/4 ok
//   nvidia/nemotron-3-ultra-550b-a55b:free  6.4s 13.3s 0.4s 2.8s  -> 3/4 ok
// Lightning is both more reliable AND faster, so it is the better default and
// the fallback ordering follows the measurement, not reputation.

import test from "node:test";
import assert from "node:assert/strict";

import { routeFor, classifyTask, TASKS } from "../router.js";

test("a greeting is chat, not research", () => {
  assert.equal(classifyTask("hey"), "chat");
  assert.equal(classifyTask("morning!"), "chat");
  assert.equal(classifyTask("thanks, that works"), "chat");
  assert.equal(classifyTask("the meeting got pushed to thursday"), "chat");
});

test("a question needing current facts is research", () => {
  assert.equal(classifyTask("what is the weather in Beijing today"), "research");
  assert.equal(classifyTask("how about the air quality in singapore"), "research");
  assert.equal(classifyTask("what's the latest on the mars sample return"), "research");
  assert.equal(classifyTask("who won last night"), "research");
});

test("a request for a written deliverable is a draft", () => {
  // This is the class the persona's old length cap was destroying.
  assert.equal(classifyTask("draft a proposal for a partnership with Acme"), "draft");
  assert.equal(classifyTask("write up a plan for the launch"), "draft");
  assert.equal(classifyTask("put together a short brief"), "draft");
});

test("an explicit instruction wins over the guess", () => {
  // A person who says "just chat" means it, even if the words look like a task.
  assert.equal(classifyTask("no tools, just chat about this"), "chat");
  assert.equal(classifyTask("don't search, I already know"), "chat");
});

test("routing picks the chat model for chat and a stronger one for work", () => {
  assert.equal(routeFor("hey").model, TASKS.chat.model);
  assert.equal(routeFor("draft a proposal for Acme").model, TASKS.draft.model);
  assert.equal(routeFor("what is the weather in Beijing today").model, TASKS.research.model);
});

test("every task carries a fallback chain, because every call can fail", () => {
  for (const task of Object.values(TASKS)) {
    assert.ok(task.fallbacks.length >= 1, `${task.id} needs a fallback`);
    assert.ok(task.model, `${task.id} needs a primary`);
    assert.ok(!task.fallbacks.includes(task.model), `${task.id} falls back to itself`);
  }
});

test("routing never returns an empty plan", () => {
  for (const q of ["", "   ", null, undefined, "\u{1F642}", "a".repeat(5000)]) {
    const r = routeFor(q);
    assert.ok(r && typeof r.model === "string" && r.model.length > 0);
    assert.ok(Array.isArray(r.chain) && r.chain.length > 0);
  }
});

test("an empty or unclassifiable message still gets a chat reply", () => {
  assert.equal(routeFor("").task, "chat");
  assert.equal(routeFor(null).task, "chat");
});

test("the chat model is the measured-reliable one, not the flagship", () => {
  // Guarding the measured finding, so a future "upgrade" cannot quietly
  // reintroduce the slower, less reliable default.
  assert.match(TASKS.chat.model, /lightning/i);
});

test("a routed chain never repeats a model", () => {
  for (const q of ["hey", "what is the weather now", "draft a proposal"]) {
    const { chain } = routeFor(q);
    assert.equal(new Set(chain).size, chain.length, `repeat in ${chain.join(", ")}`);
  }
});