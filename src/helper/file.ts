import * as path from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import { CONGIF_FILENAME } from '../constants';
import { upath } from '../core';

export function isValidFile(uri: vscode.Uri) {
  return uri.scheme === 'file';
}

export function isConfigFile(uri: vscode.Uri) {
  const filename = path.basename(uri.fsPath);
  return filename === CONGIF_FILENAME;
}

export function fileDepth(file: string) {
  return upath.normalize(file).split('/').length;
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.svg',
  '.tif',
  '.tiff',
  '.avif',
]);

// TextDocumentContentProvider can only surface a document as text, and
// showTextDocument forces the plain-text editor -- neither can render an
// image, so callers need to detect this case up front and route through
// vscode.open (which resolves the built-in image preview) instead.
export function isImageFile(fsPath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(fsPath).toLowerCase());
}

export function makeTmpFile(option): Promise<string> {
  return new Promise((resolve, reject) => {
    tmp.file({ ...option, discardDescriptor: true }, (err, tmpPath) => {
      if (err) reject(err);

      resolve(tmpPath);
    });
  });
}
