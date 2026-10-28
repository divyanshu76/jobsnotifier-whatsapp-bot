// The message was definitely not handed to WhatsApp (e.g. not connected). Safe to retry.
export class NotSentError extends Error {
    name = "NotSentError";
}

// The send started but its outcome is unknown (timeout, connection dropped mid-send).
export class UncertainSendError extends Error {
    name = "UncertainSendError";
}

// No usable WhatsApp session: the user must link the device again.
export class AuthRequiredError extends Error {
    name = "AuthRequiredError";
}

// Another WhatsApp Web client using this session took over the connection.
export class SessionReplacedError extends Error {
    name = "SessionReplacedError";
}
