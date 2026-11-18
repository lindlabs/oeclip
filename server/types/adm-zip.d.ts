declare module "adm-zip" {
  export interface ZipEntry {
    entryName: string;
    isDirectory: boolean;
    header: {
      size: number;
      compressedSize: number;
    };
    getData(): Buffer;
  }

  export default class AdmZip {
    constructor(fileName?: string | Buffer);
    getEntries(): ZipEntry[];
    readAsText(entry: ZipEntry | string): string;
  }
}
