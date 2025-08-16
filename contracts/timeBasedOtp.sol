// SPDX-License-Identifier: BSD-3-Clause-Clear

pragma solidity ^0.8.24;

import "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title TOTP
 * @dev On chain time based one time password using FHE.
 * This contract allows an user to create one time passwords on chain. The secret is stored encrypted in this contract.
 * It can be retrieved by the client and decrypted in order to generate an OTP that can be used an auth method.
 */

contract TOTP is SepoliaConfig {
    struct secretEntry {
        bool isSet;
        euint32 value;
        uint16 salt;
    }

    mapping(address => secretEntry) private secret;
    mapping(address => mapping(address => uint32)) private allowance;

    // Necessary mapping as the encrypted types have to stay in the DA to be later decrypted.
    mapping(address => euint64) private lastOTP;
    mapping(address => ebool) private lastCheck;
    mapping(address from => mapping(address to => euint64 password)) lastOTPFrom;
    mapping(address from => mapping(address to => ebool isValid)) lastCheckFrom;

    event OneTimePassword(address user, euint64 password, uint256 timestamp);
    event OTPCheck(address user, ebool isValid, uint256 timestamp);
    event ExternalOTPCheck(address user, address requestSender, ebool isValid, uint256 timestamp);

    constructor() {}

    /**
     * @dev Modifier to ensure that a user has created a secret before calling certain functions.
     */
    modifier registeredOnly() {
        require(secret[msg.sender].isSet, "User must have created a secret or generated an OTP before.");
        _;
    }

    /**
     * @dev Modifier to ensure that a user is allowed to generate an OTP on another user behalf.
     * @param from The address of the user that allows or not.
     * @param strict This parameter determine if the allowannce is > 0 or >= 0.
     * This is important because a temp allowance is = 1. Then the allowed user has to retrieve this OTP.
     * However the getLastOTPFrom function is protected by this modifier, and the allowance is now 0.
     * We have to allow the user to retrieve, not generate, this OTP even if its allowance is 0.
     */
    modifier allowedOnly(address from, bool strict) {
        require(
            (allowance[from][msg.sender] > 0 || !strict),
            "User is not allowed to generate a TOTP on behalf of the provided address."
        );
        _;
    }

    /**
     * @dev Internal function that generates a salt for the user based on their address.
     * This ensures the OTP is never zero.
     * @param user The address of the user.
     */
    function _generateUserSalt(address user) internal {
        uint16 userAddLastHex = uint16(uint160(user) % 256); // Extract last byte of the address.
        uint16 userSalt = userAddLastHex + 27; // Add 27 to ensure non-zero salt.
        secret[user].salt = userSalt;
    }

    /**
     * @dev Internal function that creates an encrypted secret for a user.
     * @param user The address of the user.
     */
    function _createSecret(address user) internal {
        _generateUserSalt(user);
        euint32 randomSecret = FHE.randEuint32();
        secret[user].value = randomSecret;
        secret[user].isSet = true;

        FHE.allowThis(secret[user].value);
        FHE.allow(secret[user].value, user);
    }

    /**
     * @dev Public function that allows a user to create an encrypted secret.
     * Can be called multiple time by an user to reset the secret.
     */
    function createSecret() public {
        _createSecret(msg.sender);
    }

    /**
     * @dev Internal function that derives an OTP based on the given timestamp and user secret.
     * @param timestamp The timestamp used to generate the OTP.
     * @param user The address of the user.
     * @return euint64 The generated OTP (encrypted).
     */
    function _deriveOTP(uint256 timestamp, address user) internal returns (euint64) {
        //if timestampKey * secret[user].value is zero, the OTP will still be positive as we add the salt.
        uint32 timestampKey = uint32(timestamp % 1000000);
        euint64 OTPSeed = FHE.add(
            FHE.mul(FHE.asEuint64(secret[user].value), timestampKey),
            FHE.asEuint64(secret[user].salt)
        );

        //Note : must be stored in an euint64, but in reality it is a small 4 digits number.
        euint64 OTP = FHE.rem(OTPSeed, 10000);

        return OTP;
    }

    /**
     * @dev Inernal function that generates a one-time password for user param.
     * If the user has no secret, it creates one automatically.
     * @param timestamp The target timestamp to generate OTP from.
     * @param user The target user.
     * @return euint64 The generated OTP (encrypted).
     */
    function _generateOtp(uint256 timestamp, address user) internal returns (euint64) {
        if (!secret[user].isSet) {
            _createSecret(user);
        }

        euint64 OTP = _deriveOTP(timestamp, user);

        lastOTP[user] = OTP;
        FHE.allow(lastOTP[user], address(this));
        FHE.allow(lastOTP[user], user);

        emit OneTimePassword(user, lastOTP[user], timestamp);
        return lastOTP[user];
    }

    /**
     * @dev Public function that generates a one-time password for the caller.
     * @param timestamp The timestamp on which the OTP will be generated
     * @return euint64 The generated OTP (encrypted).
     */
    function generateOtp(uint256 timestamp) public returns (euint64) {
        return _generateOtp(timestamp, msg.sender);
    }

    /**
     * @dev Public function that generates a one-time password for the caller.
     * If the user has no secret, it creates one automatically.
     * The OTP is based on block timestamp.
     * @return euint64 The generated OTP (encrypted).
     */
    function generateOtp() public returns (euint64) {
        return _generateOtp(block.timestamp, msg.sender);
    }

    /**
     * @dev Internal function that generates a one-time password on the behalf of an user.
     * @param from The address of the user the OTP is genrated from.
     * @param to The address authorized to use the OTP.
     * @param timestamp The timestamp used to generate the OTP.
     * @return euint64 The generated OTP (encrypted).
     */
    function _generateOtpFrom(address from, address to, uint256 timestamp) internal returns (euint64) {
        euint64 OTP = _deriveOTP(timestamp, from);
        lastOTPFrom[from][to] = OTP;

        FHE.allowThis(lastOTPFrom[from][to]);
        FHE.allow(lastOTPFrom[from][to], from);
        FHE.allow(lastOTPFrom[from][to], to);

        if (allowance[from][to] != type(uint32).max) {
            allowance[from][to]--;
        }
        return lastOTPFrom[from][to];
    }

    /**
     * @dev Public function that generates a one-time password on the behalf of an user.
     * @param from The address of the user the timestamp is genrated from.
     * @param timestamp The timestamp used to generate the OTP.
     * @return euint64 The generated OTP (encrypted).
     */
    function generateOtpFrom(address from, uint256 timestamp) public allowedOnly(from, true) returns (euint64) {
        return _generateOtpFrom(from, msg.sender, timestamp);
    }

    /**
     * @dev Public function that generates a one-time password on the behalf of an user.
     * This OTP will be based on the block timestamp.
     * @param from The address of the user the timestamp is genrated from.
     * @return euint64 The generated OTP (encrypted).
     */
    function generateOtpFrom(address from) public allowedOnly(from, true) returns (euint64) {
        return _generateOtpFrom(from, msg.sender, block.timestamp);
    }

    /**
     * @dev Internal function that checks whether a provided OTP matches the expected value.
     * @param password The provided encrypted OTP.
     * @param timestamp The timestamp used to generate the OTP.
     * @param user The address of the user.
     * @return ebool Whether the provided OTP is valid.
     */
    function _checkOtp(euint64 password, uint256 timestamp, address user) internal returns (ebool) {
        return FHE.eq(password, _deriveOTP(timestamp, user));
    }

    /**
     * @dev Public function that checks if an OTP is valid.
     * @param password The encrypted OTP to check.
     * @param timestamp The timestamp used to generate the OTP.
     * @return ebool Whether the provided OTP is valid.
     */
    function checkOtp(euint64 password, uint256 timestamp) public registeredOnly returns (ebool) {
        ebool isValid = _checkOtp(password, timestamp, msg.sender);

        lastCheck[msg.sender] = isValid;
        FHE.allowThis(lastCheck[msg.sender]);
        FHE.allow(lastCheck[msg.sender], msg.sender);

        emit OTPCheck(msg.sender, lastCheck[msg.sender], timestamp);

        return lastCheck[msg.sender];
    }

    /**
     * @dev Public function that checks an encrypted OTP input.
     * @param encryptedPassword The encrypted OTP provided by the user.
     * @param timestamp The timestamp used to generate the OTP.
     * @param inputProof Proof required for homomorphic encryption.
     */
    function checkOtp(
        externalEuint64 encryptedPassword,
        uint256 timestamp,
        bytes memory inputProof
    ) public registeredOnly {
        euint64 password = FHE.fromExternal(encryptedPassword, inputProof);
        ebool isValid = _checkOtp(password, timestamp, msg.sender);

        lastCheck[msg.sender] = isValid;
        FHE.allowThis(lastCheck[msg.sender]);
        FHE.allow(lastCheck[msg.sender], msg.sender);

        emit OTPCheck(msg.sender, lastCheck[msg.sender], timestamp);
    }

    /**
     * @dev Public function that checks if an OTP is valid.
     * @param password The encrypted OTP to check.
     * @param from The target user.
     * @param timestamp The timestamp used to generate the OTP.
     * @return ebool Whether the provided OTP is valid.
     */
    function checkOtpFrom(euint64 password, address from, uint256 timestamp) public registeredOnly returns (ebool) {
        ebool isValid = _checkOtp(password, timestamp, from);

        lastCheckFrom[from][msg.sender] = isValid;
        FHE.allowThis(lastCheckFrom[from][msg.sender]);
        FHE.allow(lastCheckFrom[from][msg.sender], msg.sender);
        FHE.allow(lastCheckFrom[from][msg.sender], from);

        emit ExternalOTPCheck(from, msg.sender, lastCheckFrom[from][msg.sender], timestamp);

        return lastCheckFrom[from][msg.sender];
    }

    /**
     * @dev Public function that checks an encrypted OTP input generated on behalf of a given user.
     * @param encryptedPassword The encrypted OTP provided by the user.
     * @param from The target user.
     * @param timestamp The timestamp used to generate the OTP.
     * @param inputProof Proof required for homomorphic encryption.
     */
    function checkOtpFrom(
        externalEuint64 encryptedPassword,
        address from,
        uint256 timestamp,
        bytes memory inputProof
    ) public registeredOnly {
        euint64 password = FHE.fromExternal(encryptedPassword, inputProof);
        ebool isValid = _checkOtp(password, timestamp, from);

        lastCheckFrom[from][msg.sender] = isValid;
        FHE.allowThis(lastCheckFrom[from][msg.sender]);
        FHE.allow(lastCheckFrom[from][msg.sender], msg.sender);
        FHE.allow(lastCheckFrom[from][msg.sender], from);

        emit ExternalOTPCheck(from, msg.sender, lastCheckFrom[from][msg.sender], timestamp);
    }

    /**
     * @dev Public function that allows an user to generate a TOTP on the behalf of msg.sender.
     * This is a 1 time allowance.
     * @param targetUser Address of the allowed user.
     */
    function allow(address targetUser) public registeredOnly {
        allowance[msg.sender][targetUser] = 1;
    }

    /**
     * @dev Public function that allows an user to generate a TOTP on the behalf of msg.sender.
     * @param targetUser Address of the allowed user.
     * @param allowanceAmount The number of TOTP code the allowed user can generate. type(uint32).max -> unlimited
     */
    function allow(address targetUser, uint32 allowanceAmount) public registeredOnly {
        allowance[msg.sender][targetUser] = allowanceAmount;
    }

    /**
     * @dev Public function that retrieves the user's encrypted secret.
     * @return euint32 The user's encrypted secret.
     */
    function getSecret() public view registeredOnly returns (euint32) {
        return secret[msg.sender].value;
    }

    /**
     * @dev Public function that retrieves the user's last generated OTP.
     * @return euint64 The last OTP (encrypted).
     */
    function getLastOtp() public view registeredOnly returns (euint64) {
        return lastOTP[msg.sender];
    }

    /**
     * @dev Public function that retrieves the user's last OTP validation result.
     * @return ebool Whether the last checked OTP was valid.
     */
    function getLastOtpCheck() public view registeredOnly returns (ebool) {
        return lastCheck[msg.sender];
    }

    /**
     * @dev Public function that retrieves the user's last OTP validation result.
     * @param from The address of the user to get the OTP from.
     * @return ebool Whether the last checked OTP was valid.
     */
    function getLastOtpCheckFrom(address from) public view registeredOnly returns (ebool) {
        return lastCheckFrom[from][msg.sender];
    }

    /**
     * @dev Public function that retrieves the user's last generated OTP on its behalf.
     * @param from The address of the user to get the OTP from.
     * @return euint64 The last OTP (encrypted) on user (from) behalf.
     */
    function getLastOtpFrom(address from) public view allowedOnly(from, false) returns (euint64) {
        return lastOTPFrom[from][msg.sender];
    }

    /**
     * @dev Public function that retrieves the user's allowance for an address.
     * @param target Address of the allowed user.
     * @return uint32 The number of generations allowed for a certain user. If it is type(uint32).max -> infinite allowance.
     */
    function getAllowance(address target) public view registeredOnly returns (uint32) {
        return allowance[msg.sender][target];
    }
}
