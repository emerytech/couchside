"""TV stream must honor controller ownership and tolerate invalid frames."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
spec = importlib.util.spec_from_file_location("tvstream", Path(__file__).parents[1]/"agent/couchsided.py")
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

class StreamTests(unittest.TestCase):
    def test_holder_gate_and_validation(self):
        handler = Mock()
        handler._CONTROL_TYPES = cs.Handler._CONTROL_TYPES
        payload = json.dumps({"t":"tvp","op":"move","dx":4,"dy":-3}).encode()
        with patch.object(cs,"webos_available",return_value=True), patch.object(cs,"real_webos_pointer",return_value={"ok":True}) as send:
            self.assertTrue(cs.Handler._gamepad_message(handler,None,{"held":False},payload))
            send.assert_not_called()
            self.assertTrue(cs.Handler._gamepad_message(handler,None,{"held":True},payload))
            send.assert_called_once_with({"t":"tvp","op":"move","dx":4,"dy":-3})
        with patch.object(cs,"webos_available",return_value=True), patch.object(cs,"_wsend_json") as reply:
            bad = json.dumps({"t":"tvp","op":"move","dx":True,"dy":0}).encode()
            self.assertTrue(cs.Handler._gamepad_message(handler,None,{"held":True},bad))
            self.assertEqual(reply.call_args.args[1]["t"],"tvp_error")

if __name__ == "__main__": unittest.main()
