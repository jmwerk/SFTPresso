export interface FileHandleOption {
  ignore?: ((filepath: string) => boolean) | null;
  // megabytes; files over this are skipped during a batch walk (folder
  // transfer/sync), never for an explicitly-requested single-file transfer.
  // 0 or undefined disables.
  maxFileSize?: number;
  // set by upload on save and the file watcher; afterUpload skips these unless onSave
  automatic?: boolean;
}
