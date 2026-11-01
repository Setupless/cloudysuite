// Applies R2's rules, so a test fails on what R2 itself would refuse.
export class FakeBucket {
  objects = new Map<string, Uint8Array>();
  failPutsMatching: RegExp | null = null;
  failDeletes = false;
  failGets = false;
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  // Runs inside delete(), after the caller listed its keys and before they go.
  beforeDelete: (() => Promise<void>) | null = null;

  async put(key: string, value: ArrayBuffer | Uint8Array) {
    if (this.failPutsMatching?.test(key)) throw new Error("R2 is unavailable");
    this.objects.set(
      key,
      value instanceof Uint8Array ? value.slice() : new Uint8Array(value),
    );
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) {
    if (this.failGets) throw new Error("R2 is unavailable");
    const whole = this.objects.get(key);
    if (!whole) return null;
    const { offset = 0, length = whole.length } = options?.range ?? {};
    const bytes = whole.subarray(offset, offset + length);
    return {
      body: new Blob([bytes as BlobPart]).stream(),
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length } : null;
  }

  async createMultipartUpload(key: string) {
    const uploadId = crypto.randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const live = () => {
      const upload = this.uploads.get(uploadId);
      if (!upload) {
        throw new Error(
          "The specified multipart upload does not exist. (10024)",
        );
      }
      return upload;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: ArrayBuffer) => {
        live().parts.set(partNumber, new Uint8Array(value));
        return { partNumber, etag: `etag-${partNumber}` };
      },
      abort: async () => {
        live();
        this.uploads.delete(uploadId);
      },
      complete: async (parts: { partNumber: number }[]) => {
        const upload = live();
        const sized = parts.map((part) => upload.parts.get(part.partNumber)!);
        const [first] = sized;
        if (sized.slice(0, -1).some((part) => part.length !== first!.length)) {
          throw new Error("All parts but the last must be the same size.");
        }
        const joined = new Uint8Array(
          sized.reduce((sum, part) => sum + part.length, 0),
        );
        let written = 0;
        for (const part of sized) {
          joined.set(part, written);
          written += part.length;
        }
        this.objects.set(key, joined);
        this.uploads.delete(uploadId);
        return { size: joined.length };
      },
    };
  }

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }

  async delete(keys: string[]) {
    await this.beforeDelete?.();
    if (this.failDeletes) throw new Error("R2 is unavailable");
    for (const key of keys) this.objects.delete(key);
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}
