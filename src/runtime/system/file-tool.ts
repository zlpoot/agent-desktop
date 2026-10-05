import { copyFile, lstat, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { constants } from "node:fs";

function within(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === "" || (part !== ".." && !part.startsWith(`..\\`) &&
    !part.startsWith("../") && !isAbsolute(part));
}

/** 只在指定目录内操作普通文件；路径经过真实路径校验，不跟随指向目录外的符号链接。 */
export class FileTool {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<FileTool> {
    return new FileTool(await realpath(root));
  }

  private async existing(path: string): Promise<string> {
    const absolute = resolve(this.root, path);
    if (!within(this.root, absolute)) throw new Error("文件路径超出允许目录");
    const actual = await realpath(absolute);
    if (!within(this.root, actual)) throw new Error("符号链接指向允许目录之外");
    return actual;
  }

  private async destination(path: string): Promise<string> {
    const absolute = resolve(this.root, path);
    if (!within(this.root, absolute) || !within(this.root, await realpath(dirname(absolute)))) {
      throw new Error("目标路径超出允许目录");
    }
    if (basename(absolute) === "." || basename(absolute) === "..") throw new Error("目标文件名无效");
    return absolute;
  }

  async list(path = "."): Promise<Array<{ name: string; directory: boolean }>> {
    const target = await this.existing(path);
    const items = await readdir(target, { withFileTypes: true });
    if (items.length > 500) throw new Error("目录项目过多");
    return items.map((item) => ({ name: item.name, directory: item.isDirectory() }));
  }

  async readText(path: string): Promise<string> {
    const source = await this.existing(path);
    const details = await stat(source);
    if (!details.isFile() || details.size > 1024 * 1024) throw new Error("仅允许读取 1 MB 内的普通文件");
    return readFile(source, "utf8");
  }

  async copy(sourcePath: string, destinationPath: string): Promise<void> {
    const source = await this.existing(sourcePath);
    if ((await lstat(resolve(this.root, sourcePath))).isSymbolicLink()) {
      throw new Error("不复制符号链接");
    }
    if (!await this.isAllowedFile(source)) throw new Error("仅允许复制 20 MB 内的普通文件");
    await copyFile(source, await this.destination(destinationPath), constants.COPYFILE_EXCL);
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    const source = await this.existing(sourcePath);
    if ((await lstat(resolve(this.root, sourcePath))).isSymbolicLink()) {
      throw new Error("不移动符号链接");
    }
    if (!await this.isAllowedFile(source)) throw new Error("仅允许移动 20 MB 内的普通文件");
    const destination = await this.destination(destinationPath);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await unlink(source);
  }

  rename(sourcePath: string, filename: string): Promise<void> {
    if (!filename || filename === "." || filename === ".." || filename.includes("/") ||
        filename.includes("\\")) throw new Error("文件名无效");
    return this.move(sourcePath, join(dirname(sourcePath), filename));
  }

  private async isAllowedFile(path: string): Promise<boolean> {
    const details = await stat(path);
    return details.isFile() && details.size <= 20 * 1024 * 1024;
  }
}
