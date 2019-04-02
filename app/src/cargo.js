const {
  cargoCmd,
  rustcCmd,
  wasmGCCmd,
  tempDir,
  rootDir,
  wasmBindgenCmd,
  wasmBindgenDeps,
} = require("../config.js");
const { exec, joinCmd, exists, writeFile, readFile, mkdir, unlink } = require("./common.js");

function checkBuildPlan(plan) {
  let success = true;
  let invocations = plan["invocations"];

  var custom_build = invocations.find(function(element) {
    return element["target_kind"].includes("custom-build");
  });

  if (custom_build) {
    success = false;
    return { success, output: "", message: "the build includes custom builds" };
  }

  if (invocations.length > 1) {
    success = false;
    return { success, output: "", message: "dependencies are currently deactivated" };
  }

  return { "success": true };
}

async function wasmGC(wasmFile, callback) {
  if (!await exists(wasmFile)) {
    throw new Error("wasm is not found")
  }
  await exec(joinCmd([wasmGCCmd, wasmFile]));
}

async function cargo(tar, options = {}) {
  let crateName = 'rustc_h_' + Math.random().toString(36).slice(2);
  let crateDir = tempDir + '/' + crateName;

  await mkdir(crateDir);

  let rustTar = crateDir + '/' + 'lib.tar';
  let wasmFile = crateDir + '/' + 'lib.wasm';
  await writeFile(rustTar, tar);
  let args = ["bash", "-c", "'cd " + crateDir + "; base64 -d " + rustTar + " > data.bin; tar xf data.bin -C .; rm data.bin'"];
  await exec(joinCmd(args));

  await writeFile(crateDir + '/Cargo.lock', await readFile(rootDir + '/../Cargo.lock'))

  try {
    // Replace dependencies from the original Cargo file
    let cargoTemplate = (await readFile(rootDir + '/../Cargo.toml')).toString('ascii');
    let re = /(^\[dependencies\]([^][^\[].+)+)/m;
    let deps = cargoTemplate.match(re);
    let cargoUser = (await readFile(crateDir + '/Cargo.toml')).toString('ascii');
    if (deps) {
      if (cargoUser.match(re)) {
        cargoUser = cargoUser.replace(re, deps[0]);
      } else {
        cargoUser = cargoUser + deps[0];
      }
    } else {
      // Clear dependencies from user submitted file
      cargoUser = cargoUser.replace(re, '');
    }
    await writeFile(crateDir + '/Cargo.toml', cargoUser);

    let args = [cargoCmd, "build"];
    args.push('--manifest-path=' + crateDir + '/' + 'Cargo.toml');
    args.push('--target=wasm32-unknown-unknown');
    args.push('--target-dir=' + rootDir + '/../target');

    if (!options.debug) {
      args.push('--release');
    }

    let planArgs = args.slice(0);
    planArgs.push("-Z unstable-options");
    planArgs.push("--build-plan");
    planArgs.push("--quiet");

    let buildPlanOutput = await exec(joinCmd(planArgs), {});
    let buildPlan = JSON.parse(buildPlanOutput);

    let checkResult = checkBuildPlan(buildPlan);

    // Disable build plan check
    // if (!checkResult.success)
    //   return checkResult;

    let output;
    let success = false;

    try {
      output = await exec(joinCmd(args), {});
      success = true;
    } catch(e) {
      output = 'error: ' + e;
    }
    try {
      if (!success)
        return { success, output: "", message: output };

      let wasmFile = Object.keys(buildPlan["invocations"].slice(-1)[0]["links"])[0];

      let wasmBindgenJs = "";
      let wasm = await readFile(wasmFile);

      let m = await WebAssembly.compile(wasm);
      let ret = { success, message: output };
      if (WebAssembly.Module.customSections(m, "__wasm_bindgen_unstable").length !== 0) {
        await exec(joinCmd([wasmBindgenCmd, wasmFile, '--no-modules', '--out-dir', tempDir]));
        wasm = await readFile(wasmFile + '_bg.wasm');
        ret.wasmBindgenJs = (await readFile(baseName + '.js')).toString();
      } else {
        await exec(joinCmd([wasmGCCmd, wasmFile]));
        wasm = await readFile(wasmFile);
      }
      ret.output = wasm.toString('base64');
      return ret;
    } finally {
      if (success) {}
        //await unlink(wasmFile);
    }
  } finally {
    //await unlink(crateDir);
  }
}

module.exports = function(source, options, callback) {
  cargo(source, options)
    .then(result => callback(null, result))
    .catch(err => callback(err, null));
};
