import { defu } from "defu";
import { hasProtocol, joinURL, withLeadingSlash } from "ufo";
import type { SharpOptions } from "sharp";
import { createError } from "h3";
// @ts-ignore
import { imageMeta as getImageMeta, type ImageMeta } from "image-meta";
import type { Config as SVGOConfig } from "svgo";
import cacache from 'cacache'
// @ts-ignore
import { hash,murmurHash } from "ohash";
import { resolve } from 'pathe'
import type { IPXStorage } from "./types";
import { HandlerName, applyHandler, getHandler } from "./handlers";
import { cachedPromise, getEnv } from "./utils";

type IPXSourceMeta = { mtime?: Date; maxAge?: number };

export type IPX = (
  id: string,
  modifiers?: Partial<
    Record<HandlerName | "f" | "format" | "a" | "animated", string>
  >,
  requestOptions?: any,
) => {
  getSourceMeta: () => Promise<IPXSourceMeta>;
  process: () => Promise<{
    data: Buffer | string;
    meta?: ImageMeta;
    format?: string;
  }>;
};

export type IPXOptions = {
  maxAge?: number;
  alias?: Record<string, string>;
  sharpOptions?: SharpOptions;

  storage: IPXStorage;
  httpStorage?: IPXStorage;
  storageMaxAge?:number
  svgo?: false | SVGOConfig;
};

// https://sharp.pixelplumbing.com/#formats
// (gif and svg are not supported as output)
const SUPPORTED_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
  "avif",
  "tiff",
  "heif",
  "gif",
  "heic",
]);

export function createIPX(userOptions: IPXOptions): IPX {
  const options: IPXOptions = defu(userOptions, {
    alias: getEnv<Record<string, string>>("IPX_ALIAS") || {},
    maxAge: getEnv<number>("IPX_MAX_AGE") ?? 60 /* 1 minute */,
    sharpOptions: {},
  } satisfies Omit<IPXOptions, "storage">);
  const cachePath = resolve('./.cache');
  // Normalize alias to start with leading slash
  options.alias = Object.fromEntries(
    Object.entries(options.alias || {}).map((e) => [
      withLeadingSlash(e[0]),
      e[1],
    ]),
  );

  // Sharp loader
  const getSharp = cachedPromise(async () => {
    return (await import("sharp").then(
      (r) => r.default || r,
    )) as typeof import("sharp");
  });

  const getSVGO = cachedPromise(async () => {
    const { optimize } = await import("svgo");
    return { optimize };
  });

  return function ipx(id, modifiers = {}, opts = {}) {
    // Validate id
    if (!id) {
      throw createError({
        statusCode: 400,
        statusText: `IPX_MISSING_ID`,
        message: `Resource id is missing`,
      });
    }

    // Enforce leading slash for non absolute urls
    id = hasProtocol(id) ? id : withLeadingSlash(id);

    // Resolve alias
    for (const base in options.alias) {
      if (id.startsWith(base)) {
        id = joinURL(options.alias[base], id.slice(base.length));
      }
    }
    // Resolve Storage
    const storage = hasProtocol(id)
      ? options.httpStorage || options.storage
      : options.storage || options.httpStorage;
    if (!storage) {
      throw createError({
        statusCode: 500,
        statusText: `IPX_NO_STORAGE`,
        message: "No storage configured!",
      });
    }

    // Resolve Resource
    const getSourceMeta = cachedPromise(async () => {
      const sourceMeta = await storage.getMeta(id, opts);
      if (!sourceMeta) {
        throw createError({
          statusCode: 404,
          statusText: `IPX_RESOURCE_NOT_FOUND`,
          message: `Resource not found: ${id}`,
        });
      }
      const _maxAge = sourceMeta.maxAge ?? options.maxAge;
      return {
        maxAge:
          typeof _maxAge === "string" ? Number.parseInt(_maxAge) : _maxAge,
        mtime: sourceMeta.mtime ? new Date(sourceMeta.mtime) : undefined,
      } satisfies IPXSourceMeta;
    });
    const getSourceData = cachedPromise(async () => {
      const sourceData = await storage.getData(id, opts);
      if (!sourceData) {
        throw createError({
          statusCode: 404,
          statusText: `IPX_RESOURCE_NOT_FOUND`,
          message: `Resource not found: ${id}`,
        });
      }
      return Buffer.from(sourceData);
    });

    const process = cachedPromise(async () => {
      const sourceData = await getSourceData();

      // Detect source image meta
      let imageMeta: ImageMeta;
      try {
        imageMeta = getImageMeta(sourceData) as ImageMeta;
      } catch {
        throw createError({
          statusCode: 400,
          statusText: `IPX_INVALID_IMAGE`,
          message: `Cannot parse image metadata: ${id}`,
        });
      }

      // Determine format
      let mFormat = modifiers.f || modifiers.format;
      if (mFormat === "jpg") {
        mFormat = "jpeg";
      }
      const format =
        mFormat && SUPPORTED_FORMATS.has(mFormat)
          ? mFormat
          : SUPPORTED_FORMATS.has(imageMeta.type || "") // eslint-disable-line unicorn/no-nested-ternary
          ? imageMeta.type
          : "jpeg";

      // Use original SVG if format is not specified
      if (imageMeta.type === "svg" && !mFormat) {
        if (options.svgo === false) {
          return {
            data: sourceData,
            format: "svg+xml",
            meta: imageMeta,
          };
        } else {
          // https://github.com/svg/svgo
          const { optimize } = await getSVGO();
          const svg = optimize(sourceData.toString("utf8"), {
            ...options.svgo,
            plugins: ["removeScriptElement", ...(options.svgo?.plugins || [])],
          }).data;
          return {
            data: svg,
            format: "svg+xml",
            meta: imageMeta,
          };
        }
      }

      // Experimental animated support
      // https://github.com/lovell/sharp/issues/2275
      const animated =
        modifiers.animated !== undefined ||
        modifiers.a !== undefined ||
        format === "gif";

      const Sharp = await getSharp();
      let sharp = Sharp(sourceData, { animated, ...options.sharpOptions });
      Object.assign(
        (sharp as unknown as { options: SharpOptions }).options,
        options.sharpOptions,
      );

      // Resolve modifiers to handlers and sort
      const handlers = Object.entries(modifiers)
        .map(([name, arguments_]) => ({
          handler: getHandler(name as HandlerName),
          name,
          args: arguments_,
        }))
        .filter((h) => h.handler)
        .sort((a, b) => {
          const aKey = (a.handler.order || a.name || "").toString();
          const bKey = (b.handler.order || b.name || "").toString();
          return aKey.localeCompare(bKey);
        });

      // Apply handlers
      const handlerContext: any = { meta: imageMeta };
      for (const h of handlers) {
        sharp = applyHandler(handlerContext, sharp, h.handler, h.args) || sharp;
      }
      // Apply format
      if (SUPPORTED_FORMATS.has(format || "")) {
        sharp = sharp.toFormat(format as any, {
          quality: handlerContext.quality||65,
          progressive: format === "jpeg",
        });
      }
      const processedImage = await sharp.toBuffer();
      return {
        data: processedImage,
        format,
        meta: imageMeta,
      };
    });
    const  getItem=async (file:string) =>{
      try {
        return await cacache.get(cachePath,file)
      }catch {
        return null
      }
    }
    // eslint-disable-next-line require-await
   const cacacheGet=cachedPromise(async () =>{
     const file=murmurHash(id)+hash(modifiers);
     const item= await getItem(file) ;
     const storageMaxAge=options.storageMaxAge||7*60*60*24;
     if (item&&(item.metadata.time+storageMaxAge)>=Date.now()){
       return {
         data:item.data,
         ...item.metadata.image,
       }
     }else {
       console.log(`Cache Time:${item?.metadata?.time} maxAge:${options.maxAge}`)
       await cacache.rm(cachePath,file)
     };
     const data=await process();
     await cacache.put(cachePath,file,data.data,{
       metadata:{
         time:Date.now(),
         image:{
           format:data.format,
           meta: data.meta,
         }
       }
     })
     return data
   })
    return {
      getSourceMeta,
      process:async () => {
        const data=await cacacheGet();
        if (data){ return data; }
        return  await process()
      },
    };
  };
}
