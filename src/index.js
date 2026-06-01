"use strict";

const querystring = require("querystring"); // Don't install.

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

// http://sharp.pixelplumbing.com/en/stable/api-resize/
const Sharp = require("sharp");

const s3Client = new S3Client({
  region: "ap-northeast-2", // 버킷을 생성한 리전 입력(여기선 서울)
});

const BUCKET = require("./config").BUCKET;

// Image types that can be handled by Sharp
const SUPPORT_IMAGE_TYPES = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "tiff",
];

const streamToBuffer = stream => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
};

const getImageFromS3 = ({ Bucket, Key }) => {
  return new Promise((resolve, reject) => {
    console.log("objectKey : ", Key);
    s3Client
      .send(
        new GetObjectCommand({
          Bucket,
          Key,
        })
      )
      .then(resolve)
      .catch(reject);
  });
};

const convertString = (string, { from, to }) => {
  if (!from || !to) return string.toLowerCase();
  return string.toLowerCase() === from ? to : string.toLowerCase();
};

const getValidatedQueryParams = request => {
  return new Promise((resolve, reject) => {
    const { uri, querystring: query } = request;
    const { w, h, q, f } = querystring.parse(query);

    console.log(`params: ${JSON.stringify(querystring.parse(query))}`);

    // 크기 조절이 없는 경우 원본 반환.
    if (!(w || h)) {
      return reject("No resizing parameters");
    }

    const extension = uri.match(/\/?(.*)\.(.*)/)[2].toLowerCase();

    if (!SUPPORT_IMAGE_TYPES.some(type => type === extension)) {
      return reject(`Unsupported image type : ${extension}`);
    }

    const width = parseInt(w, 10) || null;
    const height = parseInt(h, 10) || null;
    const quality = parseInt(q, 10) || 100;
    const format = convertString(f || extension, { from: "jpg", to: "jpeg" });

    // 포맷 변환이 없는 GIF 포맷 요청은 원본 반환.
    if (extension === "gif" && !f) {
      return reject("GIF format without format conversion");
    }

    return resolve({ width, height, quality, format });
  });
};

// new Promise(async ...) 안티패턴 제거 — Promise constructor는 async 함수의 throw를 잡지 못해
// Unhandled Promise Rejection을 일으킴. async/await + try/catch 패턴으로 통일.
const getResizedImage = async (imageBuffer, { width, height, format, quality }) => {
  try {
    const sharpInstance = Sharp(imageBuffer);
    const { width: originWidth = 0, height: originHeight = 0 } =
      await sharpInstance.metadata();

    // 원본 이미지보다 크게 요청할 경우 원본 반환.
    if (originWidth < (width ?? 0) || originHeight < (height ?? 0)) {
      throw new Error("Requested size is larger than the original image");
    }

    const resizedImage = await sharpInstance
      .resize(width, height)
      .toFormat(format, { quality })
      .withMetadata() // 이미지 크기조절시 임의로 이미지 회전하는 상황 방지
      .toBuffer();

    if (Buffer.byteLength(resizedImage, "base64") >= 1048576) {
      throw new Error("The response image size is over 1MB");
    }

    return resizedImage;
  } catch (error) {
    throw new Error(`Sharp Error: ${error?.message || JSON.stringify(error)}`);
  }
};

exports.handler = async (event, context, callback) => {
  const { request, response } = event.Records[0].cf;

  // 어떤 단계에서든 실패하면 원본 응답 그대로 통과시키는 단일 fallback.
  // (이전 코드는 각 step 마다 catch + callback(null, response) 반환 → 후속 step이 undefined로 진행하다
  //  unhandled rejection 발생 가능. 단일 try/catch로 통일.)
  try {
    const params = await getValidatedQueryParams(request);
    const s3Image = await getImageFromS3({
      Bucket: BUCKET,
      Key: decodeURIComponent(request.uri).substring(1),
    });
    const imageBuffer = await streamToBuffer(s3Image.Body);
    const resizedImage = await getResizedImage(imageBuffer, params);

    console.log("Success resizing image");

    return callback(null, {
      ...response,
      body: resizedImage.toString("base64"),
      contentHeader: [
        {
          key: "Content-Type",
          value: `image/${params.format}`,
        },
      ],
      bodyEncoding: "base64",
    });
  } catch (error) {
    console.log("ResizeImage fallback to original:", error?.message || error);
    return callback(null, response);
  }
};
