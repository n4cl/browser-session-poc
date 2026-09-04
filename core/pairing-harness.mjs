import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadOrCreateProfileMetadata, createPairingDescriptor, createSocketPath, resolvePairingPaths, writeActivePairingDescriptor } from "./pairing-descriptor.mjs";
import { PairingSocketServer } from "./pairing-socket-server.mjs";
import { installNativeHost, nativeHostManifestContent, nativeHostWrapperContent, resolveNativeHostPaths } from "./native-host-manifest.mjs";

function mode(info) { return info.mode & 0o777; }
async function absentOrPrivate(file, expected = 0o600) {
  try { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile() || mode(info) !== expected) throw new Error("unsafe pairing harness file"); return info; } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function atomicNew(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600); try { await handle.writeFile(content); } finally { await handle.close(); }
}
async function atomicReplace(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

export async function startPairingHarness({ runtimeRoot, instanceId, ttlMs = 60_000, now = () => new Date(), createUuid = randomUUID, repositoryRoot = path.resolve(import.meta.dirname, ".."), executablePath = process.execPath }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  const claimPath = path.join(paths.runtimeRoot, "pairing-claims", `${instanceId}.claim`);
  const generationPath = path.join(paths.instanceDir, "pairing-generation.json");
  const owner = { instance_id: instanceId, owner_id: createUuid() };
  await atomicNew(claimPath, `${JSON.stringify(owner)}\n`);
  let descriptor; let server;
  try {
    const metadata = await loadOrCreateProfileMetadata(paths, { createUuid });
    const existing = await absentOrPrivate(generationPath);
    let generation = 0;
    if (existing) {
      const state = JSON.parse(await readFile(generationPath, "utf8"));
      if (Object.keys(state).length !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0) throw new Error("invalid pairing generation state");
      generation = state.generation;
    }
    generation += 1;
    await atomicReplace(generationPath, `${JSON.stringify({ generation })}\n`);
    const hostPaths = resolveNativeHostPaths({ repositoryRoot, runtimeRoot: paths.runtimeRoot, instanceId, executablePath });
    const expectedManifest = nativeHostManifestContent(hostPaths); const expectedWrapper = nativeHostWrapperContent(hostPaths);
    const currentManifest = await readFile(hostPaths.manifestPath, "utf8").catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
    const currentWrapper = await readFile(hostPaths.wrapperPath, "utf8").catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
    if ((currentManifest !== null && currentManifest !== expectedManifest) || (currentWrapper !== null && currentWrapper !== expectedWrapper)) throw new Error("Native Host manifest or wrapper does not match this instance");
    if (currentManifest === null || currentWrapper === null) await installNativeHost(hostPaths);
    const socketPath = await createSocketPath(paths, { createUuid });
    const issuedAt = now(); const expiresAt = new Date(issuedAt.valueOf() + ttlMs);
    descriptor = createPairingDescriptor({ paths, profileInstanceId: metadata.profile_instance_id, sessionId: createUuid(), generation, socketPath, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), leaseId: createUuid(), pairingNonce: createUuid() });
    server = new PairingSocketServer({ paths, descriptor, profileInstanceId: metadata.profile_instance_id, now: issuedAt });
    await server.listen();
    await writeActivePairingDescriptor(paths, descriptor, { profileInstanceId: metadata.profile_instance_id, now: issuedAt });
    return { paths, descriptor, server, async close() {
      await server.close();
      try { if ((await readFile(paths.activeDescriptorPath, "utf8")) === `${JSON.stringify(descriptor)}\n`) await rm(paths.activeDescriptorPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      try { if ((await readFile(claimPath, "utf8")) === `${JSON.stringify(owner)}\n`) await rm(claimPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    } };
  } catch (error) {
    await server?.close();
    try { if ((await readFile(claimPath, "utf8")) === `${JSON.stringify(owner)}\n`) await rm(claimPath); } catch {}
    throw error;
  }
}
