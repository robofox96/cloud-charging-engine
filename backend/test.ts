import { performance } from "perf_hooks";
import supertest from "supertest";
import { buildApp } from "./app";

const app = supertest(buildApp());

async function basicLatencyTest() {
    await app.post("/reset").expect(204);
    const start = performance.now();
    const requests = [
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200),
        app.post("/charge").expect(200)
    ];
    const responses = await Promise.all(requests);
    console.log(`Latency: ${performance.now() - start} ms`);

    responses.forEach((response, index) => {
        console.log(`Response ${index + 1}:`, response.status, response.body);
        // You can add assertions or other actions here
    });
}

async function runTests() {
    await basicLatencyTest();
}

runTests().catch(console.error);
