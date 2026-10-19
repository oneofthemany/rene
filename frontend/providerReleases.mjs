// Provider releases the workbench downloads, pinned per host. Approved
// updates (see providerUpdates.mjs) override version, url, size and sha256.

const MiB = 1024 * 1024;

/**
 * Pinned releases per host. `size` is the exact download size, checked with
 * the digest; `diskBytes` is roughly what the unpacked install takes.
 * `settings` maps each variable to a path inside the unpacked top folder
 * ("" is the folder itself).
 */
export const RELEASES = {
  "linux-x64": [
    {
      id: "jdk",
      label: "Java 21 (Eclipse Temurin)",
      version: "21.0.12.1+1",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz",
      sha256:
        "ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94",
      size: 207473347,
      diskBytes: 345 * MiB,
      archive: "tar.gz",
      settings: { JAVA_HOME: "" },
      purpose: "Runs Ghidra and JADX.",
    },
    {
      id: "ghidra",
      label: "Ghidra",
      version: "12.1.4",
      url: "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip",
      sha256:
        "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db",
      size: 569649598,
      diskBytes: 880 * MiB,
      archive: "zip",
      settings: { GHIDRA_INSTALL_DIR: "" },
      needs: "jdk",
      purpose: "Native binaries: decompiled code, assembly, xrefs.",
    },
    {
      id: "jadx",
      label: "jadx-headless-mcp",
      version: "0.7.1",
      url: "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar",
      sha256:
        "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75",
      size: 42619858,
      diskBytes: 41 * MiB,
      archive: "file",
      fileName: "jadx-headless-mcp-0.7.1-all.jar",
      settings: { REA_JADX_MCP_JAR: "jadx-headless-mcp-0.7.1-all.jar" },
      needs: "jdk",
      purpose: "Android APKs.",
    },
    {
      id: "kuna",
      label: "Kuna",
      version: "1.833",
      url: "https://github.com/Noelo-Lab/kuna/releases/download/v1.833/kuna-v1.833-linux-x86_64.tar.gz",
      sha256:
        "e9f047fb5a93925ede6d869df22c26c1c0ced90764ace7467ae90f880625d530",
      size: 22305032,
      diskBytes: 45 * MiB,
      archive: "tar.gz",
      settings: { REA_KUNA_COMMAND: "kuna" },
      purpose: "A second native decompiler; no Java needed.",
    },
  ],
  "linux-arm64": [
    {
      id: "jdk",
      label: "Java 21 (Eclipse Temurin)",
      version: "21.0.12.1+1",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz",
      sha256:
        "23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223",
      size: 205641175,
      diskBytes: 345 * MiB,
      archive: "tar.gz",
      settings: { JAVA_HOME: "" },
      purpose: "Runs Ghidra and JADX.",
    },
    {
      id: "ghidra",
      label: "Ghidra",
      version: "12.1.4",
      url: "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip",
      sha256:
        "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db",
      size: 569649598,
      diskBytes: 880 * MiB,
      archive: "zip",
      settings: { GHIDRA_INSTALL_DIR: "" },
      needs: "jdk",
      purpose:
        "Native binaries. The release may lack the linux_arm_64 decompiler, which you then build yourself.",
    },
    {
      id: "jadx",
      label: "jadx-headless-mcp",
      version: "0.7.1",
      url: "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar",
      sha256:
        "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75",
      size: 42619858,
      diskBytes: 41 * MiB,
      archive: "file",
      fileName: "jadx-headless-mcp-0.7.1-all.jar",
      settings: { REA_JADX_MCP_JAR: "jadx-headless-mcp-0.7.1-all.jar" },
      needs: "jdk",
      purpose: "Android APKs.",
    },
    {
      id: "kuna",
      label: "Kuna",
      version: "1.833",
      url: "https://github.com/Noelo-Lab/kuna/releases/download/v1.833/kuna-v1.833-linux-arm64.tar.gz",
      sha256:
        "c1f7cd7cdb990cdf1149d2f595a56adf3a4afce052d014b2b6670adbfbcc71e5",
      size: 21884026,
      diskBytes: 45 * MiB,
      archive: "tar.gz",
      settings: { REA_KUNA_COMMAND: "kuna" },
      purpose: "A second native decompiler; no Java needed.",
    },
  ],
};
