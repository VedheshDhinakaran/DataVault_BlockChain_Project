// Use the solc-js (WebAssembly) compiler shipped in the `solc` npm package
// instead of letting Hardhat download a native compiler from
// binaries.soliditylang.org. Only loaded when SOLC_FROM_NPM=true.
//   npm i -D solc@0.8.28 -w contracts
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  const solcPkg = require("solc/package.json");
  if (args.solcVersion !== solcPkg.version) return runSuper();
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: require("solc").version(),
  };
});
