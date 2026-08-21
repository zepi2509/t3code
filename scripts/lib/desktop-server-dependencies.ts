const externalPackagePrefixes = ["@ff-labs/fff-node", "node-pty"];

export function shouldBundleDesktopServerDependency(id: string): boolean {
  return !externalPackagePrefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}/`));
}
