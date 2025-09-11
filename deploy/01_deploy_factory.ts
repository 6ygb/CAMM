import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, log } = hre.deployments;

  const lib = await get("CAMMPairLib");

  const factory = await deploy("CAMMFactory", {
    from: deployer,
    log: true,
    libraries: {
      CAMMPairLib: lib.address,
    },
  });

  log(`CAMMFactory: ${factory.address}`);
};

export default func;
func.id = "01_deploy_factory";
func.tags = ["factory", "CAMMFactory"];
func.dependencies = ["00_deploy_cammpairlib"]; // ensure ordering
