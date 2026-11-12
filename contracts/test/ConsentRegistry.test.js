const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const READ = 1;
const SHARE = 2;
const PROCESS = 4;
const Category = { Health: 0, Finance: 1, Education: 2, Location: 3, Other: 4 };
const Status = { None: 0, Active: 1, Revoked: 2 };

const purpose = (p) => ethers.keccak256(ethers.toUtf8Bytes(p));
const RESEARCH = purpose("research");
const MARKETING = purpose("marketing");
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const CID2 = "bafkreidummyrotatedciddummyrotatedciddummyrotatedcid000000";
const HASH = ethers.keccak256(ethers.toUtf8Bytes("ciphertext-1"));
const HASH2 = ethers.keccak256(ethers.toUtf8Bytes("ciphertext-2"));

async function deployFixture() {
  const [admin, owner, requester, other, gateway] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory("ConsentRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.setGateway(gateway.address, true);
  return { registry, admin, owner, requester, other, gateway };
}

async function withDataFixture() {
  const f = await deployFixture();
  await f.registry.connect(f.owner).registerData(CID, HASH, Category.Health);
  return { ...f, dataId: 1n };
}

async function withConsentFixture() {
  const f = await withDataFixture();
  await f.registry.connect(f.owner).grantConsent(f.dataId, f.requester.address, RESEARCH, READ, 0);
  return { ...f, consentId: 1n };
}

describe("ConsentRegistry", function () {
  describe("deployment and admin", function () {
    it("sets the admin as owner and authorises the gateway", async function () {
      const { registry, admin, gateway } = await loadFixture(deployFixture);
      expect(await registry.owner()).to.equal(admin.address);
      expect(await registry.isGateway(gateway.address)).to.equal(true);
    });

    it("only the admin can set gateways", async function () {
      const { registry, other } = await loadFixture(deployFixture);
      await expect(registry.connect(other).setGateway(other.address, true))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(other.address);
    });

    it("emits GatewaySet and can de-authorise", async function () {
      const { registry, gateway } = await loadFixture(deployFixture);
      await expect(registry.setGateway(gateway.address, false))
        .to.emit(registry, "GatewaySet")
        .withArgs(gateway.address, false);
      expect(await registry.isGateway(gateway.address)).to.equal(false);
    });

    it("rejects the zero address as gateway", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.setGateway(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        registry,
        "InvalidRequester"
      );
    });
  });

  describe("registerData", function () {
    it("stores only pointer, hash, category and owner, and emits DataRegistered", async function () {
      const { registry, owner } = await loadFixture(deployFixture);
      await expect(registry.connect(owner).registerData(CID, HASH, Category.Finance))
        .to.emit(registry, "DataRegistered")
        .withArgs(1, owner.address, Category.Finance, CID, HASH);

      const d = await registry.getData(1);
      expect(d.owner).to.equal(owner.address);
      expect(d.cid).to.equal(CID);
      expect(d.contentHash).to.equal(HASH);
      expect(d.category).to.equal(Category.Finance);
      expect(d.pointerVersion).to.equal(1);
      expect(await registry.getDataIdsByOwner(owner.address)).to.deep.equal([1n]);
      expect(await registry.dataCount()).to.equal(1);
    });

    it("rejects an empty CID or zero hash", async function () {
      const { registry, owner } = await loadFixture(deployFixture);
      await expect(registry.connect(owner).registerData("", HASH, 0)).to.be.revertedWithCustomError(
        registry,
        "InvalidPointer"
      );
      await expect(registry.connect(owner).registerData(CID, ethers.ZeroHash, 0)).to.be.revertedWithCustomError(
        registry,
        "InvalidPointer"
      );
    });

    it("rejects an out-of-range category", async function () {
      const { registry, owner } = await loadFixture(deployFixture);
      await expect(registry.connect(owner).registerData(CID, HASH, 9)).to.be.reverted;
    });

    it("reverts getData for unknown ids", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.getData(42)).to.be.revertedWithCustomError(registry, "DataNotFound").withArgs(42);
    });
  });

  describe("grantConsent", function () {
    it("creates an active, version-1 consent and emits ConsentGranted", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withDataFixture);
      const expiry = (await time.latest()) + 3600;
      await expect(registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, READ | PROCESS, expiry))
        .to.emit(registry, "ConsentGranted")
        .withArgs(1, dataId, requester.address, RESEARCH, READ | PROCESS, expiry);

      const c = await registry.getConsent(1);
      expect(c.dataId).to.equal(dataId);
      expect(c.requester).to.equal(requester.address);
      expect(c.purpose).to.equal(RESEARCH);
      expect(c.actions).to.equal(READ | PROCESS);
      expect(c.expiresAt).to.equal(expiry);
      expect(c.version).to.equal(1);
      expect(c.status).to.equal(Status.Active);
      expect(await registry.consentIndex(dataId, requester.address, RESEARCH)).to.equal(1);
      expect(await registry.getConsentIdsByData(dataId)).to.deep.equal([1n]);
      expect(await registry.getConsentIdsByRequester(requester.address)).to.deep.equal([1n]);
    });

    it("only the data owner can grant", async function () {
      const { registry, other, requester, dataId } = await loadFixture(withDataFixture);
      await expect(registry.connect(other).grantConsent(dataId, requester.address, RESEARCH, READ, 0))
        .to.be.revertedWithCustomError(registry, "NotDataOwner")
        .withArgs(dataId, other.address);
    });

    it("rejects unknown data", async function () {
      const { registry, owner, requester } = await loadFixture(withDataFixture);
      await expect(
        registry.connect(owner).grantConsent(99, requester.address, RESEARCH, READ, 0)
      ).to.be.revertedWithCustomError(registry, "DataNotFound");
    });

    it("rejects zero address or self as requester", async function () {
      const { registry, owner, dataId } = await loadFixture(withDataFixture);
      await expect(
        registry.connect(owner).grantConsent(dataId, ethers.ZeroAddress, RESEARCH, READ, 0)
      ).to.be.revertedWithCustomError(registry, "InvalidRequester");
      await expect(
        registry.connect(owner).grantConsent(dataId, owner.address, RESEARCH, READ, 0)
      ).to.be.revertedWithCustomError(registry, "InvalidRequester");
    });

    it("rejects invalid action masks", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withDataFixture);
      await expect(registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, 0, 0))
        .to.be.revertedWithCustomError(registry, "InvalidActions")
        .withArgs(0);
      await expect(registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, 8, 0))
        .to.be.revertedWithCustomError(registry, "InvalidActions")
        .withArgs(8);
    });

    it("rejects an expiry in the past", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withDataFixture);
      const past = (await time.latest()) - 1;
      await expect(
        registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, READ, past)
      ).to.be.revertedWithCustomError(registry, "InvalidExpiry");
    });

    it("rejects a duplicate active consent for the same requester and purpose", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withConsentFixture);
      await expect(registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, SHARE, 0))
        .to.be.revertedWithCustomError(registry, "ConsentAlreadyExists")
        .withArgs(1);
    });

    it("allows separate consents for different purposes", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).grantConsent(dataId, requester.address, MARKETING, READ, 0);
      expect(await registry.isAccessAllowed(dataId, requester.address, MARKETING, READ)).to.equal(true);
      expect(await registry.getConsentIdsByRequester(requester.address)).to.deep.equal([1n, 2n]);
    });
  });

  describe("modifyConsent", function () {
    it("changes actions and expiry in place and increments version", async function () {
      const { registry, owner, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      const expiry = (await time.latest()) + 1000;
      await expect(registry.connect(owner).modifyConsent(consentId, RESEARCH, READ | SHARE, expiry))
        .to.emit(registry, "ConsentModified")
        .withArgs(consentId, dataId, requester.address, RESEARCH, READ | SHARE, expiry, 2);

      const c = await registry.getConsent(consentId);
      expect(c.version).to.equal(2);
      expect(c.actions).to.equal(READ | SHARE);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, SHARE)).to.equal(true);
    });

    it("moves the consent to a new purpose", async function () {
      const { registry, owner, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).modifyConsent(consentId, MARKETING, READ, 0);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, requester.address, MARKETING, READ)).to.equal(true);
      expect(await registry.consentIndex(dataId, requester.address, RESEARCH)).to.equal(0);
      expect(await registry.consentIndex(dataId, requester.address, MARKETING)).to.equal(consentId);
    });

    it("refuses to move onto a purpose that already has an active consent", async function () {
      const { registry, owner, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).grantConsent(dataId, requester.address, MARKETING, READ, 0);
      await expect(registry.connect(owner).modifyConsent(consentId, MARKETING, READ, 0))
        .to.be.revertedWithCustomError(registry, "ConsentAlreadyExists")
        .withArgs(2);
    });

    it("can reduce actions so a previously allowed action is denied", async function () {
      const { registry, owner, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).modifyConsent(consentId, RESEARCH, PROCESS, 0);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, PROCESS)).to.equal(true);
    });

    it("only the data owner can modify", async function () {
      const { registry, requester, consentId } = await loadFixture(withConsentFixture);
      await expect(
        registry.connect(requester).modifyConsent(consentId, RESEARCH, 7, 0)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");
    });

    it("cannot modify a revoked or unknown consent", async function () {
      const { registry, owner, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).revokeConsent(consentId);
      await expect(registry.connect(owner).modifyConsent(consentId, RESEARCH, READ, 0))
        .to.be.revertedWithCustomError(registry, "ConsentNotActive")
        .withArgs(consentId);
      await expect(registry.connect(owner).modifyConsent(77, RESEARCH, READ, 0))
        .to.be.revertedWithCustomError(registry, "ConsentNotFound")
        .withArgs(77);
    });

    it("validates new terms", async function () {
      const { registry, owner, consentId } = await loadFixture(withConsentFixture);
      await expect(registry.connect(owner).modifyConsent(consentId, RESEARCH, 0, 0)).to.be.revertedWithCustomError(
        registry,
        "InvalidActions"
      );
    });
  });

  describe("revokeConsent", function () {
    it("sets status to Revoked, clears the index and emits ConsentRevoked", async function () {
      const { registry, owner, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      await expect(registry.connect(owner).revokeConsent(consentId))
        .to.emit(registry, "ConsentRevoked")
        .withArgs(consentId, dataId, requester.address);

      const c = await registry.getConsent(consentId);
      expect(c.status).to.equal(Status.Revoked);
      expect(await registry.consentIndex(dataId, requester.address, RESEARCH)).to.equal(0);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(false);
      expect(await registry.isConsentEffective(consentId)).to.equal(false);
    });

    it("only the data owner can revoke", async function () {
      const { registry, requester, other, consentId } = await loadFixture(withConsentFixture);
      await expect(registry.connect(requester).revokeConsent(consentId)).to.be.revertedWithCustomError(
        registry,
        "NotDataOwner"
      );
      await expect(registry.connect(other).revokeConsent(consentId)).to.be.revertedWithCustomError(
        registry,
        "NotDataOwner"
      );
    });

    it("cannot revoke twice", async function () {
      const { registry, owner, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).revokeConsent(consentId);
      await expect(registry.connect(owner).revokeConsent(consentId)).to.be.revertedWithCustomError(
        registry,
        "ConsentNotActive"
      );
    });

    it("allows a fresh grant after revocation", async function () {
      const { registry, owner, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).revokeConsent(consentId);
      await registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, READ, 0);
      expect(await registry.consentIndex(dataId, requester.address, RESEARCH)).to.equal(2);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(true);
    });
  });

  describe("isAccessAllowed", function () {
    it("always allows the data owner", async function () {
      const { registry, owner, dataId } = await loadFixture(withDataFixture);
      expect(await registry.isAccessAllowed(dataId, owner.address, RESEARCH, 7)).to.equal(true);
    });

    it("denies unknown data, zero action, wrong purpose, wrong requester and missing action bits", async function () {
      const { registry, requester, other, dataId } = await loadFixture(withConsentFixture);
      expect(await registry.isAccessAllowed(99, requester.address, RESEARCH, READ)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, 0)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, requester.address, MARKETING, READ)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, other.address, RESEARCH, READ)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, SHARE)).to.equal(false);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ | SHARE)).to.equal(false);
    });

    it("stops allowing access once the consent expires", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withDataFixture);
      const expiry = (await time.latest()) + 3600;
      await registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, READ, expiry);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(true);
      await time.increaseTo(expiry);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(false);
      expect(await registry.isConsentEffective(1)).to.equal(false);
    });

    it("an expired consent can be renewed with modifyConsent", async function () {
      const { registry, owner, requester, dataId } = await loadFixture(withDataFixture);
      const expiry = (await time.latest()) + 100;
      await registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, READ, expiry);
      await time.increaseTo(expiry + 1);
      await registry.connect(owner).modifyConsent(1, RESEARCH, READ, 0);
      expect(await registry.isAccessAllowed(dataId, requester.address, RESEARCH, READ)).to.equal(true);
    });

    it("scan and mapping implementations agree", async function () {
      const { registry, owner, requester, other, dataId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).grantConsent(dataId, other.address, MARKETING, SHARE, 0);
      for (const [who, p, a] of [
        [requester.address, RESEARCH, READ],
        [requester.address, RESEARCH, SHARE],
        [other.address, MARKETING, SHARE],
        [other.address, RESEARCH, READ],
        [owner.address, RESEARCH, READ],
      ]) {
        expect(await registry.isAccessAllowedByScan(dataId, who, p, a)).to.equal(
          await registry.isAccessAllowed(dataId, who, p, a)
        );
      }
      await registry.connect(owner).revokeConsent(1);
      expect(await registry.isAccessAllowedByScan(dataId, requester.address, RESEARCH, READ)).to.equal(false);
    });
  });

  describe("logAccess", function () {
    it("lets an authorised gateway log an allowed access", async function () {
      const { registry, gateway, requester, dataId } = await loadFixture(withConsentFixture);
      await expect(registry.connect(gateway).logAccess(dataId, requester.address, RESEARCH, READ))
        .to.emit(registry, "AccessLogged")
        .withArgs(dataId, requester.address, RESEARCH, READ, gateway.address);
    });

    it("rejects callers that are not gateways", async function () {
      const { registry, requester, dataId } = await loadFixture(withConsentFixture);
      await expect(registry.connect(requester).logAccess(dataId, requester.address, RESEARCH, READ))
        .to.be.revertedWithCustomError(registry, "NotGateway")
        .withArgs(requester.address);
    });

    it("refuses to log an access that consent does not allow", async function () {
      const { registry, owner, gateway, requester, dataId, consentId } = await loadFixture(withConsentFixture);
      await registry.connect(owner).revokeConsent(consentId);
      await expect(
        registry.connect(gateway).logAccess(dataId, requester.address, RESEARCH, READ)
      ).to.be.revertedWithCustomError(registry, "AccessNotAllowed");
    });
  });

  describe("updateDataPointer (key rotation)", function () {
    it("updates CID and hash, bumps pointerVersion and emits DataPointerUpdated", async function () {
      const { registry, owner, dataId } = await loadFixture(withDataFixture);
      await expect(registry.connect(owner).updateDataPointer(dataId, CID2, HASH2))
        .to.emit(registry, "DataPointerUpdated")
        .withArgs(dataId, CID2, HASH2, 2);
      const d = await registry.getData(dataId);
      expect(d.cid).to.equal(CID2);
      expect(d.contentHash).to.equal(HASH2);
      expect(d.pointerVersion).to.equal(2);
    });

    it("only the owner can update the pointer, and it must be valid", async function () {
      const { registry, owner, other, dataId } = await loadFixture(withDataFixture);
      await expect(
        registry.connect(other).updateDataPointer(dataId, CID2, HASH2)
      ).to.be.revertedWithCustomError(registry, "NotDataOwner");
      await expect(
        registry.connect(owner).updateDataPointer(dataId, "", HASH2)
      ).to.be.revertedWithCustomError(registry, "InvalidPointer");
    });
  });

  describe("audit trail", function () {
    it("rebuilds the full consent history from events alone", async function () {
      const { registry, owner, requester, gateway, dataId } = await loadFixture(withDataFixture);
      await registry.connect(owner).grantConsent(dataId, requester.address, RESEARCH, READ, 0);
      await registry.connect(gateway).logAccess(dataId, requester.address, RESEARCH, READ);
      await registry.connect(owner).modifyConsent(1, RESEARCH, READ | SHARE, 0);
      await registry.connect(owner).revokeConsent(1);

      const filters = ["DataRegistered", "ConsentGranted", "AccessLogged", "ConsentModified", "ConsentRevoked"];
      const logs = [];
      for (const name of filters) logs.push(...(await registry.queryFilter(registry.filters[name]())));
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      expect(logs.map((l) => l.fragment.name)).to.deep.equal(filters);
    });
  });
});
