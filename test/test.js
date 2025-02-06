const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BorrowLend", function () {
  async function deployFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock price feeds
    const MockETHDapi = await ethers.getContractFactory("MockETHDapiProxy");
    const ethDapi = await MockETHDapi.deploy();
    
    const MockTokenDapi = await ethers.getContractFactory("MockDapiProxy");
    const tokenDapi = await MockTokenDapi.deploy();

    // Set prices (ETH = $2000, Token = $25)
    await ethDapi.setDapiValues(ethers.parseEther("2000"), Math.floor(Date.now() / 1000));
    await tokenDapi.setDapiValues(ethers.parseEther("25"), Math.floor(Date.now() / 1000));

    // Deploy tokens
    const WETH = await ethers.getContractFactory("WETH");
    const weth = await WETH.deploy();
    
    const Token = await ethers.getContractFactory("MyToken");
    const token = await Token.deploy();

    // Deploy main contract
    const BorrowLend = await ethers.getContractFactory("BorrowLend");
    const borrowLend = await BorrowLend.deploy();

    // Setup allowed tokens and price feeds
    await borrowLend.setNativeTokenProxyAddress(ethDapi.target);
    await borrowLend.setTokensAvailable(weth.target, ethDapi.target);
    await borrowLend.setTokensAvailable(token.target, tokenDapi.target);

    // Mint tokens to users
    await weth.connect(user1).mint();
    await token.connect(user1).mint();
    await weth.connect(user2).mint();
    await token.connect(user2).mint();

    // Transfer some tokens to the contract for liquidity
    await token.transfer(borrowLend.target, ethers.parseEther("1000"));
    await weth.transfer(borrowLend.target, ethers.parseEther("1000"));

    return {
      borrowLend,
      weth,
      token,
      ethDapi,
      tokenDapi,
      owner,
      user1,
      user2
    };
  }

  describe("Basic Operations", function () {
    it("Should allow deposits", async function () {
      const { borrowLend, weth, token, user1 } = await loadFixture(deployFixture);
      
      const depositAmount = ethers.parseEther("100");
      
      await weth.connect(user1).approve(borrowLend.target, depositAmount);
      await borrowLend.connect(user1).depositToken(weth.target, depositAmount);
      
      expect(await borrowLend.deposits(user1.address, weth.target)).to.equal(depositAmount);
    });

    it("Should allow borrows against collateral", async function () {
      const { borrowLend, weth, token, user1 } = await loadFixture(deployFixture);
      
      // Deposit WETH as collateral
      const depositAmount = ethers.parseEther("100");
      await weth.connect(user1).approve(borrowLend.target, depositAmount);
      await borrowLend.connect(user1).depositToken(weth.target, depositAmount);
      
      // Borrow tokens
      const borrowAmount = ethers.parseEther("50");
      await borrowLend.connect(user1).borrow(token.target, borrowAmount);
      
      expect(await borrowLend.borrows(user1.address, token.target)).to.equal(borrowAmount);
    });

    it("Should allow repayment", async function () {
      const { borrowLend, weth, token, user1 } = await loadFixture(deployFixture);
      
      // Setup: Deposit and Borrow
      const depositAmount = ethers.parseEther("100");
      const borrowAmount = ethers.parseEther("50");
      
      await weth.connect(user1).approve(borrowLend.target, depositAmount);
      await borrowLend.connect(user1).depositToken(weth.target, depositAmount);
      
      await borrowLend.connect(user1).borrow(token.target, borrowAmount);
      
      // Repay
      await token.connect(user1).approve(borrowLend.target, borrowAmount);
      await borrowLend.connect(user1).repay(token.target, borrowAmount);
      
      expect(await borrowLend.borrows(user1.address, token.target)).to.equal(0);
    });
  });

  describe("Liquidations", function () {
    it("Should allow liquidation when health factor drops", async function () {
        const { borrowLend, weth, token, ethDapi, tokenDapi, owner, user1, user2 } = await loadFixture(deployFixture);
        
        // Add initial liquidity to contract
        const liquidityAmount = ethers.parseEther("10000");
        await token.connect(owner).mint();
        await token.connect(owner).transfer(borrowLend.target, liquidityAmount);
        
        // User1 deposits WETH and borrows tokens
        const depositAmount = ethers.parseEther("10"); // 10 WETH = $20,000 at $2000/ETH
        const borrowAmount = ethers.parseEther("400"); // 400 tokens = $10,000 at $25/token
        
        // Initial setup
        await weth.connect(user1).approve(borrowLend.target, depositAmount);
        await borrowLend.connect(user1).depositToken(weth.target, depositAmount);
        console.log("Initial Health Factor:", (await borrowLend.healthFactor(user1.address)).toString());
        
        // Borrow tokens
        await borrowLend.connect(user1).borrow(token.target, borrowAmount);
        console.log("Health Factor after borrow:", (await borrowLend.healthFactor(user1.address)).toString());
        
        // Drop ETH price dramatically to make position unsafe
        await ethDapi.setDapiValues(ethers.parseEther("200"), Math.floor(Date.now() / 1000)); // Drop to $200
        
        // Check values before liquidation
        const healthFactor = await borrowLend.healthFactor(user1.address);
        console.log("Health Factor before liquidation:", healthFactor.toString());
        
        const [totalBorrow, totalDeposit] = await borrowLend.userInformation(user1.address);
        console.log("Total Borrow Value (USD):", totalBorrow.toString());
        console.log("Total Deposit Value (USD):", totalDeposit.toString());
        
        // Prepare liquidator
        const halfDebt = borrowAmount / 2n;
        console.log("Half Debt Amount:", halfDebt.toString());
        
        // Ensure user2 has enough tokens for liquidation
        await token.connect(user2).mint();
        await token.connect(user2).approve(borrowLend.target, halfDebt);
        
        // Execute liquidation
        await expect(
            borrowLend.connect(user2).liquidate(user1.address, token.target, weth.target)
        ).to.not.be.reverted;
        
        // Verify liquidation effects
        const newHealthFactor = await borrowLend.healthFactor(user1.address);
        console.log("Health Factor after liquidation:", newHealthFactor.toString());
        
        // Verify user2 received reward
        const user2WethBalance = await weth.balanceOf(user2.address);
        expect(user2WethBalance).to.be.gt(0);
    });

    it("Should revert liquidation when health factor is good", async function () {
        const { borrowLend, weth, token, user1, user2 } = await loadFixture(deployFixture);
        
        // Setup a healthy position
        const depositAmount = ethers.parseEther("100");
        const borrowAmount = ethers.parseEther("10"); // Small borrow
        
        await weth.connect(user1).approve(borrowLend.target, depositAmount);
        await borrowLend.connect(user1).depositToken(weth.target, depositAmount);
        await borrowLend.connect(user1).borrow(token.target, borrowAmount);
        
        // Try to liquidate healthy position
        const halfDebt = borrowAmount / 2n;
        await token.connect(user2).approve(borrowLend.target, halfDebt);
        
        await expect(
            borrowLend.connect(user2).liquidate(user1.address, token.target, weth.target)
        ).to.be.revertedWithCustomError(borrowLend, "NotLiquidatable");
    });
});
});