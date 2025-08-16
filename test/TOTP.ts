import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

describe("TOTP Tests", function () {
  before(async function () {
    this.signers = await ethers.getSigners();
    this.provider = ethers.provider;
  });

  let log_str = "";

  it("Should deploy the TOTP contract", async function () {
    const TOTPFactory = await ethers.getContractFactory("TOTP", this.signers[0]);
    const TOTPcontract = await TOTPFactory.deploy();
    await TOTPcontract.waitForDeployment();
    this.totp = TOTPcontract;

    log_str = "TOTP contract address : " + (await TOTPcontract.getAddress());
    log(log_str, "deploy TOTP contract");

    //eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await TOTPcontract.getAddress()).to.be.properAddress;
  });

  it("Should create a secret and generate a TOTP", async function () {
    const genOtpTx = await this.totp.generateOtp();
    const genOtpReceipt = await genOtpTx.wait();

    log_str = "Generate Otp status : " + parseInt(genOtpReceipt.status).toString();
    log(log_str, "Generate Otp");

    expect(genOtpReceipt.status).to.equal(1);

    const encryptedOtp = await this.totp.getLastOtp();
    const clearOtp = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedOtp,
      await this.totp.getAddress(),
      this.signers[0],
    );

    log_str = "Generated Otp : " + clearOtp;
    log(log_str, "Generate Otp");

    // The Otp must of course be a number and as it is 4 digit long, it must be within 0000 and 9999.
    expect(parseInt(clearOtp.toString())).to.be.a("number");
    expect(parseInt(clearOtp.toString())).to.be.within(0, 9999);
  });

  it("Should get the generated secret.", async function () {
    const encryptedSecret = await this.totp.getSecret();

    log_str = "Encrypted Secret : " + encryptedSecret;
    log(log_str, "Get secret");

    const clearSecret = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      encryptedSecret,
      await this.totp.getAddress(),
      this.signers[0],
    );

    this.secret = clearSecret;

    log_str = "Decrypted Secret : " + clearSecret;
    log(log_str, "Get secret");
  });

  it("Should create an otp off chain, encrypt it and compare it.", async function () {
    //get the last block timestamp
    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;

    //Salt computation
    const cleanAddress = this.signers[0].address.toLowerCase().replace(/^0x/, "");
    const lastHex = cleanAddress.slice(-2);
    const userSalt = parseInt(lastHex, 16) + 27;

    //OTP generation logic
    const timeStampKey = BigInt(blockTimestamp) % BigInt(1000000);
    const OtpSeed = this.secret * timeStampKey + BigInt(userSalt);
    const OTP = OtpSeed % BigInt(10000);

    log_str = "Offchain generated OTP " + OTP;
    log(log_str, "Generate OTP offchain");

    const checkOtpInput = fhevm.createEncryptedInput(await this.totp.getAddress(), this.signers[0].address);
    const encryptedCheckOtpInput = await checkOtpInput.add64(OTP).encrypt();

    const checkOtpTx = await this.totp["checkOtp(bytes32,uint256,bytes)"](
      encryptedCheckOtpInput.handles[0],
      blockTimestamp,
      encryptedCheckOtpInput.inputProof,
    );
    const checkOtpReceipt = await checkOtpTx.wait();

    log_str = "Check OTP status : " + parseInt(checkOtpReceipt.status).toString();
    log(log_str, "Generate OTP offchain");

    expect(parseInt(checkOtpReceipt.status)).to.equal(1);

    const encryptedOtpValidity = await this.totp.getLastOtpCheck();

    const clearOtpValidity = await fhevm.userDecryptEbool(
      encryptedOtpValidity,
      await this.totp.getAddress(),
      this.signers[0],
    );

    log_str = "Is Otp valid (decryption result) ? : " + clearOtpValidity;
    log(log_str, "Generate OTP offchain");

    expect(clearOtpValidity).to.equal(true);
  });

  it("Should temporary allow signer 0 (Alice)", async function () {
    const allowTx = await this.totp.allow(this.signers[0].address);
    const allowReceipt = await allowTx.wait();

    log_str = "Allow status : " + parseInt(allowReceipt.status).toString();
    log(log_str, "Temporary allowance");

    expect(allowReceipt.status).to.equal(1);

    const allowance = await this.totp.getAllowance(this.signers[0].address);

    log_str = "Current allowance for signer 0 (Alice) : " + allowance;
    log(log_str, "Temporary allowance");

    expect(parseInt(allowance)).to.equal(1);
  });

  it("Should generate an OTP on behalf of signer 0 (Alice).", async function () {
    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;

    const generateOtpFromTx = await this.totp["generateOtpFrom(address,uint256)"](
      this.signers[0].address,
      blockTimestamp,
    );
    const generateOtpFromReceipt = await generateOtpFromTx.wait();

    log_str = "GenerateOTPFrom status : " + generateOtpFromReceipt.status;
    log(log_str, "GenerateOTPFrom");

    expect(generateOtpFromReceipt.status).to.equal(1);

    const encryptedOTP = await this.totp.getLastOtpFrom(this.signers[0].address);

    log_str = "Generated Encrypted OTP on behalf of signer 0 (Alice) : " + encryptedOTP;
    log(log_str, "GenerateOTPFrom");

    const clearOTP = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedOTP,
      await this.totp.getAddress(),
      this.signers[0],
    );

    log_str = "Generated OTP on behalf of signer 0 (Alice) : " + clearOTP;
    log(log_str, "GenerateOTPFrom");

    expect(parseInt(clearOTP.toString())).to.be.a("number");
    expect(parseInt(clearOTP.toString())).to.be.within(0, 9999);
  });

  it("Should not generate an OTP on behalf of signer 0 (Alice).", async function () {
    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;

    try {
      await this.totp["generateOtpFrom(address,uint256)"](this.signers[0].address, blockTimestamp);
      throw new Error("Transaction did NOT revert!");
    } catch (error: unknown) {
      if (error instanceof Error) {
        log_str = "Error message : " + error.message;
        log(log_str, "Not GenerateOTPFrom");
        expect(error.message || "").to.include(
          "User is not allowed to generate a TOTP on behalf of the provided address.",
        );
      }
    }
  });

  it("Should give infinite allowance to signer 0 (Alice).", async function () {
    const UINT32_MAX = 2 ** 32 - 1;
    const allowTx = await this.totp["allow(address,uint32)"](this.signers[0].address, UINT32_MAX);
    const allowReceipt = await allowTx.wait();

    log_str = "Allow status : " + parseInt(allowReceipt.status).toString();
    log(log_str, "Infinite allowance");

    expect(allowReceipt.status).to.equal(1);

    const allowance = await this.totp.getAllowance(this.signers[0].address);

    log_str = "Current allowance for signer 0 (Alice) : " + allowance;
    log(log_str, "Infinite allowance");

    expect(parseInt(allowance)).to.equal(UINT32_MAX);
  });

  it("Should generate 10 TOTP codes in behalf of signer 0 (Alice).", async function () {
    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;

    for (let i = 0; i < 10; i++) {
      const generateOtpFromTx = await this.totp["generateOtpFrom(address,uint256)"](
        this.signers[0].address,
        blockTimestamp + i * 30,
      );
      const generateOtpFromReceipt = await generateOtpFromTx.wait();

      log_str = (i + 1).toString() + " - GenerateOTPFrom status : " + generateOtpFromReceipt.status;
      log(log_str, "Test inifinite allowance");

      expect(generateOtpFromReceipt.status).to.equal(1);

      const encryptedOTP = await this.totp.getLastOtpFrom(this.signers[0].address);
      const clearOTP = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedOTP,
        await this.totp.getAddress(),
        this.signers[0],
      );

      log_str = (i + 1).toString() + " - Generated OTP on behalf of signer 0 (Alice) : " + clearOTP + "\n";
      log(log_str, "Test infinite allowance");

      expect(parseInt(clearOTP.toString())).to.be.a("number");
      expect(parseInt(clearOTP.toString())).to.be.within(0, 9999);
    }
  });

  it("Should generate a code on behalf of signer 0 (Alice) and externaly check its validity", async function () {
    const block = await this.provider.getBlock("latest");
    const blockTimestamp = block.timestamp;

    const generateOtpFromTx = await this.totp["generateOtpFrom(address,uint256)"](
      this.signers[0].address,
      blockTimestamp,
    );
    const generateOtpFromReceipt = await generateOtpFromTx.wait();

    log_str = "GenerateOTPFrom status : " + generateOtpFromReceipt.status;
    log(log_str, "External OTP check");

    expect(generateOtpFromReceipt.status).to.equal(1);

    const encryptedOTP = await this.totp.getLastOtpFrom(this.signers[0].address);

    log_str = "Encrypted Generated OTP : " + encryptedOTP;
    log(log_str, "External OTP check");

    const clearOTP = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedOTP,
      await this.totp.getAddress(),
      this.signers[0],
    );

    log_str = "Decrypted Generated OTP : " + clearOTP;
    log(log_str, "External OTP check");

    const checkOtpInput = fhevm.createEncryptedInput(await this.totp.getAddress(), this.signers[0].address);
    const encryptedCheckOtpInput = await checkOtpInput.add64(clearOTP).encrypt();
    const checkOtpFromTx = await this.totp["checkOtpFrom(bytes32,address,uint256,bytes)"](
      encryptedCheckOtpInput.handles[0],
      this.signers[0].address,
      blockTimestamp,
      encryptedCheckOtpInput.inputProof,
    );
    const checkOtpFromReceipt = await checkOtpFromTx.wait();

    log_str = "checkOTPFrom Tx status " + checkOtpFromReceipt.status;
    log(log_str, "External OTP check");

    const encryptedExternalOTPCheck = await this.totp.getLastOtpCheckFrom(this.signers[0].address);
    log_str = "Encrypted External OTP check : " + encryptedExternalOTPCheck;
    log(log_str, "External OTP check");

    const clearExternalOTPCheck = await fhevm.userDecryptEbool(
      encryptedExternalOTPCheck,
      await this.totp.getAddress(),
      this.signers[0],
    );
    log_str = "Clear External OTP check : " + clearExternalOTPCheck;
    log(log_str, "External OTP check");
  });
});

const log = (message: string, scope: string) => {
  const log_str = `\t[DEBUG] (${scope}) : ${message}`;
  console.log(log_str);
};
