import { Uri } from 'vscode';
import app from '../app';
import { UResource, FileService, ServiceConfig } from '../core';
import logger from '../logger';
import { getFileService } from '../modules/serviceManager';
import { FileHandleOption } from './option';

interface FileHandlerConfig {
  _?: boolean;
}

export interface FileHandlerContext {
  target: UResource;
  fileService: FileService;
  config: ServiceConfig;
}

type FileHandlerContextMethod<R = void> = (this: FileHandlerContext) => R;
type FileHandlerContextMethodArg1<A, R = void> = (this: FileHandlerContext, a: A) => R;

interface FileHandlerOption<T> {
  name: string;
  handle: FileHandlerContextMethodArg1<T, Promise<any>>;
  afterHandle?: FileHandlerContextMethod;
  config?: FileHandlerConfig;
  transformOption?: FileHandlerContextMethod<T>;
}

export function handleCtxFromUri(uri: Uri): FileHandlerContext {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) === "file:///${command:sftp.sync.remoteToLocal}") {
      throw '';
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }
  const config = fileService.getConfig();
  const target = UResource.from(uri, {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: {
      host: config.host,
      port: config.port,
    },
  });

  return {
    fileService,
    config,
    target,
  };
}

export function allHandleCtxFromUri(uri: Uri): Array<FileHandlerContext> {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) === "file:///${command:sftp.sync.remoteToLocal}") {
      throw '';
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }

  const configArr = fileService.getAllConfig();

  return configArr.map(config => {
    const target = UResource.from(uri, {
      localBasePath: fileService.baseDir,
      remoteBasePath: config.remotePath,
      remoteId: fileService.id,
      remote: {
        host: config.host,
        port: config.port,
      },
    });

    return {
      fileService,
      config,
      target,
    };
  })
}

export default function createFileHandler<T>(
  handlerOption: FileHandlerOption<T>
): (ctx: FileHandlerContext | Uri, option?: Partial<T>) => Promise<void> {
  async function fileHandle(ctx: Uri | FileHandlerContext, option?: Partial<T>) {
    const handleCtx = ctx instanceof Uri ? handleCtxFromUri(ctx) : ctx;
    const { target } = handleCtx;

    const invokeOption: Partial<T> = handlerOption.transformOption
      ? handlerOption.transformOption.call(handleCtx)
      : {};
    if (option) {
      Object.assign(invokeOption, option);
    }

    // `ignore` is a convention several (not all) T's happen to include, not
    // something T is constrained to here -- same as the runtime always was.
    const ignore = (invokeOption as FileHandleOption).ignore;
    if (ignore && ignore(target.localFsPath)) {
      return;
    }

    logger.trace(`handle ${handlerOption.name} for`, target.localFsPath);

    app.sftpBarItem.startSpinner();
    try {
      // By this point invokeOption has transformOption's full T (or {}, for
      // a handler with no transformOption -- see FileHandlerOption['handle']
      // callers, none of which read anything off an empty option) merged
      // with the caller's overrides; handle() has always assumed a full T.
      await handlerOption.handle.call(handleCtx, invokeOption as T);
    // } catch (error) {
    //   reportError(error, `when ${handlerOption.name} ${target.localFsPath}`);
    //   Object.defineProperty(error, 'reported', {
    //     configurable: false,
    //     enumerable: false,
    //     value: true,
    //   });
    //   throw error;
    } finally {
      app.sftpBarItem.stopSpinner();
    }
    if (handlerOption.afterHandle) {
      handlerOption.afterHandle.call(handleCtx);
    }
  }

  return fileHandle;
}
