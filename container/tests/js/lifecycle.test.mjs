import test from "node:test";
import assert from "node:assert/strict";
import { Lifecycle, S, isFinal } from "../../static/js/transfer/lifecycle.js";

const FINAL = [S.COMPLETED, S.FAILED, S.CANCELLED, S.DECLINED, S.EXPIRED];
const ENDINGS = [S.FAILED, S.CANCELLED, S.DECLINED, S.EXPIRED];

test("a transfer walks connecting, waiting, transferring, completed", () => {
  const seen = [];
  const life = new Lifecycle((state) => seen.push(state));
  assert.equal(life.state, S.CONNECTING);
  assert.ok(life.move(S.WAITING) && life.move(S.TRANSFERRING) && life.move(S.COMPLETED));
  assert.deepEqual(seen, [S.WAITING, S.TRANSFERRING, S.COMPLETED]);
  assert.ok(life.final);
});

test("steps cannot be skipped or taken backwards", () => {
  const life = new Lifecycle();
  assert.equal(life.move(S.TRANSFERRING), false);          // data cannot flow before the other side accepted
  assert.equal(life.move(S.COMPLETED), false);             // and nothing can complete before data flowed
  assert.equal(life.move(S.CONNECTING), false);
  life.move(S.WAITING);
  assert.equal(life.move(S.CONNECTING), false);
  assert.equal(life.state, S.WAITING);
});

for (const ending of ENDINGS) {
  test(`a transfer can end as ${ending} from every live state`, () => {
    for (const steps of [[], [S.WAITING], [S.WAITING, S.TRANSFERRING]]) {
      const life = new Lifecycle();
      for (const step of steps) life.move(step);
      assert.ok(life.move(ending));
      assert.equal(life.state, ending);
    }
  });
}

for (const final of FINAL) {
  test(`${final} is final: nothing moves again, and a repeated clean-up does nothing`, () => {
    const life = new Lifecycle();
    life.move(S.WAITING);
    life.move(S.TRANSFERRING);
    life.move(final);
    let changes = 0;
    life._onChange = () => { changes += 1; };
    for (const next of [...Object.values(S)]) assert.equal(life.move(next), false);
    assert.equal(life.state, final);
    assert.equal(changes, 0);
    assert.ok(isFinal(final) && life.final);
  });
}

test("require() allows only the named states", () => {
  const life = new Lifecycle();
  assert.throws(() => life.require(S.TRANSFERRING), /Not allowed while the transfer is connecting/);
  life.move(S.WAITING);
  life.move(S.TRANSFERRING);
  assert.doesNotThrow(() => life.require(S.TRANSFERRING));
  life.move(S.CANCELLED);
  assert.throws(() => life.require(S.TRANSFERRING), /cancelled/);
});

test("only final states count as final", () => {
  for (const state of [S.CONNECTING, S.WAITING, S.TRANSFERRING]) assert.equal(isFinal(state), false);
});