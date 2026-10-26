// A stand-in DynamoDB endpoint for live tests of the golf server's ddb match
// store (MATCH_STORE_MODE=ddb): the JSON wire protocol the AWS SDK speaks, for
// just the three calls the store makes (PutItem, GetItem, and a Query on pk),
// items kept in memory as sent. Outlives any number of golf server restarts.
//
//   const ddb = await startDdbFake();
//   startGolfServer({ env: ddb.env });  ...  await ddb.stop();
const http = require("node:http");

function startDdbFake() {
  const items = new Map(); // "pk|sk" -> item, attribute values as sent
  const key = (k) => `${k.pk.S}|${k.sk.S}`;
  const ops = {
    PutItem: (b) => {
      items.set(key(b.Item), b.Item);
      return {};
    },
    GetItem: (b) =>
      items.has(key(b.Key)) ? { Item: items.get(key(b.Key)) } : {},
    Query: (b) => {
      const pk = b.ExpressionAttributeValues[":pk"].S;
      const found = [...items.values()].filter((i) => i.pk.S === pk);
      return { Items: found, Count: found.length, ScannedCount: found.length };
    },
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const op = String(req.headers["x-amz-target"] || "").split(".")[1];
      const reply = (status, obj) => {
        res.writeHead(status, {
          "content-type": "application/x-amz-json-1.0",
        });
        res.end(JSON.stringify(obj));
      };
      if (!ops[op])
        return reply(400, { __type: "UnknownOperationException", message: op });
      reply(200, ops[op](JSON.parse(body)));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        items,
        env: {
          MATCH_STORE_MODE: "ddb",
          DDB_TABLE: "golf-matches",
          DDB_ENDPOINT: `http://127.0.0.1:${port}`,
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "fake",
          AWS_SECRET_ACCESS_KEY: "fake",
        },
        stop: () => new Promise((r) => server.close(r)),
      });
    }),
  );
}

module.exports = { startDdbFake };
