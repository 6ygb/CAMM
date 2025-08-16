import { task, types } from "hardhat/config";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { TaskArguments } from "hardhat/types";
import fs from "fs";
import path from "path";

type TOTPConfig = {
  TOTP_CONTRACT_ADDRESS?: string;
  TOTP_SECRET?: string;
};

const TOTP_JSON_PATH = path.resolve(__dirname, "..", "TOTP.json");

function readConfig(): TOTPConfig {
  if (!fs.existsSync(TOTP_JSON_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TOTP_JSON_PATH, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${TOTP_JSON_PATH}: ${(e as Error).message}`);
  }
}

function writeConfig(patch: Partial<TOTPConfig>) {
  const current = readConfig();
  const merged = { ...current, ...patch };
  fs.writeFileSync(TOTP_JSON_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

function requireConfig(): TOTPConfig {
  if (!fs.existsSync(TOTP_JSON_PATH)) {
    console.warn(`Could not find TOTP.json, please run 'npx hardhat task:deploy_totp' to deploy and create it.`);
    process.exit(1);
  }
  return readConfig();
}

function generateTOTPCode(blockTimestamp: number, address: string, secret: string): bigint {
  const cleanAddress = address.toLowerCase().replace(/^0x/, "");
  const lastHex = cleanAddress.slice(-2);
  const userSalt = parseInt(lastHex, 16) + 27;

  //OTP generation logic
  const timeStampKey = BigInt(blockTimestamp) % BigInt(1000000);
  const OtpSeed = BigInt(secret) * timeStampKey + BigInt(userSalt);
  const OTP = OtpSeed % BigInt(10000);

  return OTP;
}

task("task:deploy_totp", "Deploys the TOTP contract").setAction(async function (_taskArguments: TaskArguments, hre) {
  console.log("Deploying TOTP contract.");
  const { ethers } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const TOTPFactory = await ethers.getContractFactory("TOTP");
  const TOTPContract = await TOTPFactory.connect(deployer).deploy();
  await TOTPContract.deploymentTransaction()?.wait();
  const TOTPContractAddress = await TOTPContract.getAddress();

  writeConfig({ TOTP_CONTRACT_ADDRESS: TOTPContractAddress });
  console.log(`Contract deployed at : ${TOTPContractAddress}`);
});

task("task:create_totp_secret", "Create a new secret for the current address on the TOTP contract").setAction(
  async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const contractAddress = cfg.TOTP_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("TOTP_CONTRACT_ADDRESS is not defined in TOTP.json");
    }
    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const totpContract = await ethers.getContractAt("TOTP", contractAddress, signer);
    await fhevm.initializeCLIApi();

    console.log(`Creating a new secret for current address.`);

    const createSecretTx = await totpContract.createSecret();
    const createSecretReceipt = await createSecretTx.wait();

    if (!createSecretReceipt?.status) {
      throw new Error("Create secret Tx failed.");
    }

    console.log(`Create secret tx status : ${createSecretReceipt?.status}`);
    console.log(`Retrieving the encrypted secret.`);

    const encryptedSecret = await totpContract.getSecret();
    console.log(`Encrypted secret : ${encryptedSecret}`);
    console.log(`Decrypting and storing the secret.`);

    const clearSecret = await fhevm.userDecryptEuint(FhevmType.euint32, encryptedSecret, contractAddress, signer);
    console.log(`Clear secret : ${clearSecret}`);

    writeConfig({ TOTP_SECRET: String(clearSecret) });
    console.log(`Clear secret stored.`);
  },
);

task("task:generate_code_locally", "Generate a code locally using stored secret and display it").setAction(
  async function (_taskArguments: TaskArguments, hre) {
    const { ethers } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const cfg = requireConfig();
    const totpSecret = cfg.TOTP_SECRET;
    if (!totpSecret) {
      throw new Error(
        "TOTP_SECRET is not defined in TOTP.json, run task:create_totp_secret to create and store a secret.",
      );
    }
    const currentBlock = await ethers.provider.getBlock("latest");
    if (!currentBlock) {
      throw new Error("Could not retrieve last block.");
    }
    const blockTimestamp = currentBlock.timestamp;
    const OTP = generateTOTPCode(blockTimestamp, signer.address, totpSecret);

    console.log(`Generated TOTP code : ${OTP}`);
    console.log(`Associated timestamp : ${blockTimestamp}`);
  },
);

task("task:check_code", "Generate a code locally using stored secret and display it")
  .addParam("code", "The target TOTP code.", undefined, types.int, false)
  .addParam("timestamp", "The target TOTP code timestamp.", undefined, types.int, false)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const contractAddress = cfg.TOTP_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("TOTP_CONTRACT_ADDRESS is not defined in TOTP.json");
    }
    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const totpContract = await ethers.getContractAt("TOTP", contractAddress, signer);
    await fhevm.initializeCLIApi();

    const totpCode = _taskArguments.code;
    const timestamp = _taskArguments.timestamp;

    console.log(
      `Cehcking TOTP validity \nCode : ${totpCode}\nAssociated Timestamp : ${timestamp}\nUser Address : ${signer.address}\nContract Address : ${contractAddress}`,
    );

    const clearParam = await fhevm.createEncryptedInput(contractAddress, signer.address);
    clearParam.add64(totpCode);
    const encryptedParam = await clearParam.encrypt();

    const checkTotpTx = await totpContract["checkOtp(bytes32,uint256,bytes)"](
      encryptedParam.handles[0],
      timestamp,
      encryptedParam.inputProof,
    );
    const checkOtpReceipt = await checkTotpTx.wait();

    if (!checkOtpReceipt?.status) {
      throw new Error("Check OTP Tx failed.");
    }

    console.log(`Check OTP Tx status : ${checkOtpReceipt?.status}`);
    console.log(`Retrieving and decrypting check result.`);

    const encryptedOtpCheck = await totpContract.getLastOtpCheck();
    console.log(`Encrypted check : ${encryptedOtpCheck}.`);

    const clearOtpCheck = await fhevm.userDecryptEbool(encryptedOtpCheck, contractAddress, signer);
    console.log(`Clear OTP check result : ${clearOtpCheck}`);
  });

task("task:allow_address", "Give a defined allowance to an address, to generate TOTPs on behalf of msg sender.")
  .addParam("address", "The allowed address.", undefined, types.string, false)
  .addParam("allowance", "The amount of the given allowance (infinite = max uint32).", undefined, types.int, false)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const contractAddress = cfg.TOTP_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("TOTP_CONTRACT_ADDRESS is not defined in TOTP.json");
    }
    const { ethers } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const totpContract = await ethers.getContractAt("TOTP", contractAddress, signer);

    const targetAddress = _taskArguments.address;
    const allowance = _taskArguments.allowance;

    console.log(
      `Allowance recap \nAllowed address : ${targetAddress}\nAllowance : ${allowance}\nUser Address : ${signer.address}`,
    );

    const allowTx = await totpContract["allow(address,uint32)"](targetAddress, allowance);
    const allowReceipt = await allowTx.wait();

    if (!allowReceipt?.status) {
      throw new Error(
        "Allow Tx failed. Make sure the account sender (the one allowing an address) is registered and has a secret.",
      );
    }

    console.log(`Allow Tx status : ${allowReceipt?.status}`);
  });

task("task:get_allowance", "Get the allowance for a specific address.")
  .addParam("address", "The allowed address.", undefined, types.string, false)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const contractAddress = cfg.TOTP_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("TOTP_CONTRACT_ADDRESS is not defined in TOTP.json");
    }
    const { ethers } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const totpContract = await ethers.getContractAt("TOTP", contractAddress, signer);

    const targetAddress = _taskArguments.address;

    const allowance = await totpContract.getAllowance(targetAddress);

    console.log("Current allowance :", allowance);
  });

task("task:generate_code_from", "Generates a code on behalf of provided address (needs allowance).")
  .addParam("address", "The address to generate code from.", undefined, types.string, false)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const contractAddress = cfg.TOTP_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("TOTP_CONTRACT_ADDRESS is not defined in TOTP.json");
    }
    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const totpContract = await ethers.getContractAt("TOTP", contractAddress, signer);
    await fhevm.initializeCLIApi();

    const fromAddress = _taskArguments.address;

    console.log(`${signer.address} generating a code on behalf of ${fromAddress}`);

    const currentBlock = await ethers.provider.getBlock("latest");
    if (!currentBlock) {
      throw new Error("Could not retrieve last block.");
    }
    const blockTimestamp = currentBlock.timestamp;
    const generateFromTx = await totpContract["generateOtpFrom(address,uint256)"](fromAddress, blockTimestamp);

    const generateFromReceipt = await generateFromTx.wait();

    if (!generateFromReceipt?.status) {
      throw new Error(
        "Generate OTP from Tx failed. Make sure the account sender is registered, has a secret and is allowed on the target address.",
      );
    }

    console.log("Generate OTP from Tx status :", generateFromReceipt.status);

    const encryptedOTP = await totpContract.getLastOtpFrom(fromAddress);
    console.log("Generated Encrypted OTP :", encryptedOTP);

    const clearOTP = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedOTP, contractAddress, signer);
    console.log("Clear OTP :", clearOTP);
    console.log("Associated timestamp :", blockTimestamp);
  });

task("task:check_code_from", "Check a code on behalf of provided address (needs allowance).")
  .addParam("address", "The address to generate code from.", undefined, types.string, false)
  .addParam("code", "The target TOTP code.", undefined, types.int, false)
  .addParam("timestamp", "The target TOTP code timestamp.", undefined, types.int, false)
  .setAction(async function (_taskArguments: TaskArguments, hre) {
    const cfg = requireConfig();
    const contractAddress = cfg.TOTP_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("TOTP_CONTRACT_ADDRESS is not defined in TOTP.json");
    }
    const { ethers, fhevm } = hre;
    const signers = await ethers.getSigners();
    const signer = signers[0];
    const totpContract = await ethers.getContractAt("TOTP", contractAddress, signer);
    await fhevm.initializeCLIApi();

    const fromAddress = _taskArguments.address;
    const totpCode = _taskArguments.code;
    const totpTimestamp = _taskArguments.timestamp;

    console.log(`${signer.address} checking a code on behalf of ${fromAddress}`);

    const clearParam = await fhevm.createEncryptedInput(contractAddress, signer.address);
    clearParam.add64(totpCode);
    const encryptedParam = await clearParam.encrypt();

    const checkCodeFromTx = await totpContract["checkOtpFrom(bytes32,address,uint256,bytes)"](
      encryptedParam.handles[0],
      fromAddress,
      totpTimestamp,
      encryptedParam.inputProof,
    );
    const checkCodeFromReceipt = await checkCodeFromTx.wait();

    if (!checkCodeFromReceipt?.status) {
      throw new Error(
        "Check OTP from Tx failed. Make sure the account sender is registered, has a secret and is allowed on the target address.",
      );
    }

    console.log("Check OTP from Tx status :", checkCodeFromReceipt.status);

    const encryptedOtpCheck = await totpContract.getLastOtpCheckFrom(fromAddress);
    console.log("Encrypted OTP check:", encryptedOtpCheck);

    const clearOtpCheck = await fhevm.userDecryptEbool(encryptedOtpCheck, contractAddress, signer);
    console.log("Clear OTP check:", clearOtpCheck);
  });
