const { S3Client } = require("@aws-sdk/client-s3");
const { handler } = require("../src/index");
const { Readable } = require("stream");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

jest.mock("@aws-sdk/client-s3", () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn(() => ({
      send: mockSend,
    })),
    GetObjectCommand: jest.fn(),
  };
});

describe("Lambda@Edge Handler", () => {
  let mockS3Client, imageBuffer, event, callback;

  beforeEach(() => {
    const imagePath = path.resolve(__dirname, "./test.png");
    imageBuffer = fs.readFileSync(imagePath);

    mockS3Client = new S3Client({});
    const mockStream = new Readable();
    mockStream.push(imageBuffer);
    mockStream.push(null);

    mockS3Client.send.mockResolvedValue({
      Body: mockStream,
      ContentLength: imageBuffer.length,
      ContentType: "image/png",
    });

    event = {
      Records: [
        {
          cf: {
            request: {
              uri: "/test.png",
              querystring: "w=200&h=300",
            },
            response: {
              status: "200",
              statusDescription: "OK",
              headers: {
                "content-type": [{ key: "Content-Type", value: "image/png" }],
              },
            },
          },
        },
      ],
    };

    callback = jest.fn();
  });

  it("should call the callback with the correct response structure", async () => {
    await handler(event, null, callback);
    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        status: "200",
        statusDescription: "OK",
        body: expect.any(String),
        headers: expect.objectContaining({
          "content-type": [{ key: "Content-Type", value: "image/png" }],
        }),
        bodyEncoding: "base64",
      })
    );
  });

  it("should return a base64 encoded image", async () => {
    await handler(event, null, callback);
    const base64 = callback.mock.calls[0][1]?.body;
    expect(base64).toMatch(/^[A-Za-z0-9+/=]+$/); // base64 형식 검증
  });

  it("should resize the image to the specified dimensions", async () => {
    await handler(event, null, callback);
    const base64 = callback.mock.calls[0][1]?.body;
    const resizedImage = Buffer.from(base64, "base64");

    const { width, height } = await sharp(resizedImage).metadata();
    expect(width).toBe(200);
    expect(height).toBe(300);
  });

  it("should maintain the correct content type", async () => {
    await handler(event, null, callback);
    const response = callback.mock.calls[0][1];
    expect(response.headers["content-type"]).toEqual([
      { key: "Content-Type", value: "image/png" },
    ]);
  });

  it("should set the content type to the converted format", async () => {
    event.Records[0].cf.request.querystring = "w=200&f=webp";
    await handler(event, null, callback);
    const response = callback.mock.calls[0][1];
    expect(response.headers["content-type"]).toEqual([
      { key: "Content-Type", value: "image/webp" },
    ]);
    const { format } = await sharp(Buffer.from(response.body, "base64")).metadata();
    expect(format).toBe("webp");
  });

  it("should map jpg to image/jpeg", async () => {
    event.Records[0].cf.request.querystring = "w=200&f=jpg";
    await handler(event, null, callback);
    const response = callback.mock.calls[0][1];
    expect(response.headers["content-type"]).toEqual([
      { key: "Content-Type", value: "image/jpeg" },
    ]);
  });
});
