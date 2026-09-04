// src/invariant.ts
var PACKAGE_NAME = "dsh-web-automation";
var name = "dsh-web-automation-invariant";
var inject = ["invariants"];
var install = () => {
};
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export {
  apply,
  inject,
  name
};
