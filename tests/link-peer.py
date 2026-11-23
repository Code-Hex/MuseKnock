"""Local interoperability peer. Run link-interop.test.ts with MUSE_SDK_TESTS and MUSE_PYTHON."""
import asyncio
import json
import os
import sys

from websockets.asyncio.server import serve

sys.path.insert(0, os.environ["MUSE_SDK_TESTS"])
from test_link_client import FakeVm
from musegadget.noise.envelope import ApplicationResponse, BodyChunk, ServiceFrame


async def verify(socket, events):
    worker = socket.request.path.startswith("/v1/noise")
    if worker:
        assert socket.request.path == "/v1/noise?vm_id=local-vm"
        assert socket.request.headers["Authorization"] == "Bearer local-vm-token"
    vm = FakeVm(socket)
    await vm.handshake()
    control = await vm.accept_control_stream()
    assert control.value.path == "/link-control"
    registration = await vm.next_message()
    assert registration["method"] == "link.register"
    assert registration["params"]["node_id"] == "test-123abc"
    assert registration["params"]["commands_v2"] == {}
    reject = socket.request.path == "/reject-registration"
    await vm.send_message({"type": "res", "id": registration["id"], "ok": not reject})
    if reject:
        return
    frame = await vm.next_frame()
    assert (frame.kind, frame.value.verb, frame.value.path) == ("request", "POST", "/chat/stream")
    headers = {item.key.lower(): item.value for item in frame.value.headers}
    assert headers["x-app-id"] == "musegadget" and headers["content-type"] == "application/json"
    data = frame.value.body
    ended = frame.value.end_body
    while not ended:
        chunk = await vm.next_frame()
        assert chunk.kind == "body_chunk" and chunk.stream_id == frame.stream_id
        data += chunk.value.data
        ended = chunk.value.end_body
    payload = json.loads(data)
    message = payload.pop("message")
    if worker:
        _, event = message.split("\n", 1)
        notification = json.loads(event)
        assert notification.pop("id")
        assert notification == next(events)
    else:
        assert message == "event" * 15_000
    assert payload == {
        "session_id": "same-chat",
        "device_id": "test-123abc", "output_modality": "text",
    }
    if socket.request.path == "/lost-ack":
        return
    body = {
        "/malformed-ack": b"not json",
        "/empty-ack": b"",
        "/array-ack": b"[]",
    }.get(socket.request.path, b'{"result":{"message_id":"local-id"}}')
    await vm.send_frame(ServiceFrame.response(frame.stream_id, ApplicationResponse(status=201, body=body[:8])))
    await vm.send_frame(ServiceFrame.body_chunk(frame.stream_id, BodyChunk(data=body[8:], end_body=True)))


async def main():
    finished = asyncio.Queue()
    events = iter([
        {
            "source": "default", "type": "notification", "text": '{\n  "id": 9007199254740993\n}\n',
        },
        {"source": "museknock-test", "type": "test", "text": "MuseKnock test notification."},
    ])

    async def handle(socket):
        try:
            await asyncio.wait_for(verify(socket, events), 10)
            await finished.put(None)
        except Exception as error:
            await finished.put(error)

    async with serve(handle, "127.0.0.1", 0, compression=None) as server:
        print(server.sockets[0].getsockname()[1], flush=True)
        for _ in range(8):
            error = await finished.get()
            if error:
                raise error


asyncio.run(main())
