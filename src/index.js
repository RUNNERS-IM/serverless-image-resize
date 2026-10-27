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
    // q 가 없으면 82. 100 은 파일이 몇 배 커지는데 눈으로는 차이가 거의 없다(10-27).
    const quality = parseInt(q, 10) || 82;
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
    // 원본보다 크게 요청해도 원본을 그대로 내주지 않고 원본 크기로 다시 저장한다. 원본이 큰 PNG 인 경우
    // (예: 848px 짜리 2.5MB 사진을 ?w=900 으로 요청) 원본을 그대로 보내면 화면이 그만큼 무거워진다(10-27).
    const resizedImage = await sharpInstance
      .resize(width, height, { withoutEnlargement: true })
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
