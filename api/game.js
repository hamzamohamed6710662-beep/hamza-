const Pusher = require("pusher");
const crypto = require("crypto");

let pusher;

function getPusher() {
    const {
        PUSHER_APP_ID,
        PUSHER_KEY,
        PUSHER_SECRET,
        PUSHER_CLUSTER
    } = process.env;

    if (!PUSHER_APP_ID || !PUSHER_KEY ||
        !PUSHER_SECRET || !PUSHER_CLUSTER) {
        throw new Error("Pusher environment variables are missing");
    }

    if (!pusher) {
        pusher = new Pusher({
            appId: PUSHER_APP_ID,
            key: PUSHER_KEY,
            secret: PUSHER_SECRET,
            cluster: PUSHER_CLUSTER,
            useTLS: true
        });
    }

    return pusher;
}

function encode(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createToken(room, id, secret) {
    const payload = encode({
        room,
        id,
        exp: Date.now() + 4 * 60 * 60 * 1000
    });

    const signature = crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("base64url");

    return payload + "." + signature;
}

function verifyToken(token, secret) {
    if (typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payload, signature] = parts;

    const expected = crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("base64url");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)) {
        return null;
    }

    try {
        const data = JSON.parse(
            Buffer.from(payload, "base64url").toString()
        );

        if (!data.room || !data.id || data.exp < Date.now()) {
            return null;
        }

        return data;
    } catch {
        return null;
    }
}

function createId() {
    return crypto.randomBytes(16).toString("hex");
}

function createRoomCode() {
    return String(
        crypto.randomInt(1000, 10000)
    );
}

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {
        const body = typeof req.body === "string"
            ? JSON.parse(req.body)
            : (req.body || {});

        const {
            action,
            room,
            token,
            socket_id,
            channel_name,
            payload
        } = body;

        const secret = process.env.PUSHER_SECRET;
        const client = getPusher();

        if (action === "create" || action === "join") {
            let roomCode;

            if (action === "create") {
                roomCode = createRoomCode();
            } else {
                roomCode = String(room || "");

                if (!/^\d{4}$/.test(roomCode)) {
                    return res.status(400).json({
                        error: "Invalid room code"
                    });
                }
            }

            const id = createId();
            const playerToken = createToken(
                roomCode,
                id,
                secret
            );

            return res.status(200).json({
                room: roomCode,
                id,
                token: playerToken,
                key: process.env.PUSHER_KEY,
                cluster: process.env.PUSHER_CLUSTER
            });
        }

        const player = verifyToken(token, secret);

        if (!player) {
            return res.status(401).json({
                error: "Invalid or expired session"
            });
        }

        const channel = "private-drift-" + player.room;

        if (action === "auth") {
            if (
                channel_name !== channel ||
                typeof socket_id !== "string" ||
                !/^\d+\.\d+$/.test(socket_id)
            ) {
                return res.status(403).json({
                    error: "Unauthorized channel"
                });
            }

            return res.status(200).json(
                client.authorizeChannel(socket_id, channel)
            );
        }

        if (action === "publish") {
            if (
                typeof socket_id !== "string" ||
                socket_id.length > 100 ||
                !payload ||
                typeof payload !== "object"
            ) {
                return res.status(400).json({
                    error: "Invalid player update"
                });
            }

            let safePayload;

            if (payload.kind === "bye") {
                safePayload = { kind: "bye" };
            } else if (payload.kind === "state") {
                const x = Number(payload.x);
                const z = Number(payload.z);
                const yaw = Number(payload.yaw);

                if (
                    !Number.isFinite(x) ||
                    !Number.isFinite(z) ||
                    !Number.isFinite(yaw) ||
                    Math.abs(x) > 10000000 ||
                    Math.abs(z) > 10000000
                ) {
                    return res.status(400).json({
                        error: "Invalid position"
                    });
                }

                safePayload = {
                    kind: "state",
                    car: String(payload.car || "junk").slice(0, 40),
                    x,
                    z,
                    yaw
                };
            } else {
                return res.status(400).json({
                    error: "Unknown event"
                });
            }

            await client.trigger(
                channel,
                "player-update",
                {
                    id: player.id,
                    ...safePayload
                }
            );

            return res.status(200).json({
                success: true
            });
        }

        return res.status(400).json({
            error: "Unknown action"
        });

    } catch (error) {
        console.error("Game API error:", error);

        return res.status(500).json({
            error: "Game server error"
        });
    }
};
