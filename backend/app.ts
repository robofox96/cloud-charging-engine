import express from "express";
import { WatchError, createClient } from "redis";
import { json } from "body-parser";

const DEFAULT_BALANCE = 100;

interface ChargeResult {
    isAuthorized: boolean;
    remainingBalance: number;
    charges: number;
}

async function connect(): Promise<ReturnType<typeof createClient>> {
    const url = `redis://${process.env.REDIS_HOST ?? "localhost"}:${process.env.REDIS_PORT ?? "6379"}`;
    console.log(`Using redis URL ${url}`);
    const client = createClient({ url });
    await client.connect();
    return client;
}

async function reset(account: string): Promise<void> {
    const client = await connect();
    try {
        await client.set(`${account}/balance`, DEFAULT_BALANCE);
    } finally {
        await client.disconnect();
    }
}

async function charge(account: string, charges: number): Promise<ChargeResult> {
    const client = await connect();
    try {
        const balance = parseInt((await client.get(`${account}/balance`)) ?? "");
        if (balance >= charges) {
            await client.set(`${account}/balance`, balance - charges);
            const remainingBalance = parseInt((await client.get(`${account}/balance`)) ?? "");
            return { isAuthorized: true, remainingBalance, charges };
        } else {
            return { isAuthorized: false, remainingBalance: balance, charges: 0 };
        }
    } finally {
        await client.disconnect();
    }
}

async function chargev2(account: string, charges: number): Promise<ChargeResult> {
    const client = await connect();
    try {
        return await chargev2Util(client, account, charges);
    } finally {
        await client.disconnect();
    }
}

async function chargev2Util(client: ReturnType<typeof createClient>, account: string, charges: number): Promise<ChargeResult> {
    try {
        const balanceKey = `${account}/balance`;

        // Watch the balance key to detect changes during the transaction
        await client.watch(balanceKey);

        // Start a transaction
        const multi = client.multi();

        const balance = parseInt((await client.get(balanceKey)) ?? "");

        if (balance >= charges) {
            // Deduct charges in the transaction
            multi.set(balanceKey, balance - charges);

            // Execute the transaction
            const execResult = await multi.exec();

            // Check if the transaction was successful
            if (execResult) {
                const remainingBalance = parseInt((await client.get(balanceKey)) ?? "");
                return { isAuthorized: true, remainingBalance, charges };
            }
        }

        // If the transaction was not successful or the balance was insufficient, return an unauthorized result
        return { isAuthorized: false, remainingBalance: balance, charges: 0 };
    } catch (e) {
       // if (e instanceof WatchError)
            return chargev2Util(client, account, charges);
    }
}

async function chargev3(account: string, charges: number): Promise<ChargeResult> {
    const client = await connect();
    try {
        const balanceKey = `${account}/balance`;

        // Start a transaction
        const multi = client.multi();

        let lockAcquired = false;
        let retryCount = 0;
        const maxRetries = 3; // Maximum number of retry attempts
        const retryDelay = 1000; // Delay in milliseconds between retries (adjust as needed)

        while (!lockAcquired && retryCount < maxRetries) {
            try{
                const lockKey = `${account}/lock`;
                // Attempt to acquire the lock
                await client.watch(lockKey);

            const balance = parseInt(await client.get(balanceKey) ?? "");

            if (balance >= charges) {
                multi.setNX(lockKey, 'LOCKED');
                multi.expire(lockKey, 10); // Lock expires in 10 seconds
                // Execute the transaction
                const execResult = await multi.exec();

                if (execResult) {
                    lockAcquired = true;

                    // Deduct charges
                    multi.set(balanceKey, balance - charges);

                    // Release the lock
                    multi.del(lockKey);

                    // Execute the second part of the transaction
                    await multi.exec();

                    // Read the updated balance
                    const remainingBalance = parseInt(await client.get(balanceKey) ?? "");
                    return { isAuthorized: true, remainingBalance, charges };
                }
            }

            // If the lock was not acquired, wait and retry
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            retryCount++;
            } catch (e) {
                //console.log(e);
                continue;
            }
        }

        //if (!lockAcquired) {
            return { isAuthorized: false, remainingBalance: 0, charges: 0 };
        //}
    } finally {
        await client.disconnect();
    }
}

export function buildApp(): express.Application {
    const app = express();
    app.use(json());
    app.post("/reset", async (req, res) => {
        try {
            const account = req.body.account ?? "account";
            await reset(account);
            console.log(`Successfully reset account ${account}`);
            res.sendStatus(204);
        } catch (e) {
            console.error("Error while resetting account", e);
            res.status(500).json({ error: String(e) });
        }
    });
    app.post("/charge", async (req, res) => {
        try {
            const account = req.body.account ?? "account";
            const result = await chargev2(account, req.body.charges ?? 10);
            console.log(`Successfully charged account ${account}`);
            res.status(200).json(result);
        } catch (e) {
            console.error("Error while charging account", e);
            res.status(500).json({ error: String(e) });
        }
    });
    return app;
}
