import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;

  const lib = await deploy("CAMMPairLib", {
    from: deployer,
    log: true,
  });

  log(`CAMMPairLib: ${lib.address}`);
};

export default func;
func.id = "00_deploy_cammpairlib";
func.tags = ["lib", "CAMMPairLib"];
