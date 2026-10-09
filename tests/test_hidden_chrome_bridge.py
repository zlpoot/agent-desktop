"""Synthetic admission tests only. Never initialize Win32 or start Chrome."""
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'spikes/local-workspace'))
import chrome_bridge as bridge_module
from policy import Blocked

class ChromeBridgeContractTests(unittest.TestCase):
    def bridge(self):
        obj=bridge_module.Bridge.__new__(bridge_module.Bridge)
        obj.lock=threading.RLock();obj.authority=None;obj.stopped=False
        obj.binding={'providerId':'windows-local-workspace','environmentId':'local-workspace:chrome',
            'sessionId':'synthetic','instanceId':'synthetic-instance','inputResourceId':'synthetic-resource'}
        obj.deadline=time.monotonic()+60;obj.lease=time.monotonic()+3
        obj.directory=Path('synthetic-only');obj.port=1;obj.control=lambda:None
        return obj
    def authority(self,obj):
        return {**obj.binding,'owner':{'kind':'agent','clientId':'synthetic-client'},'epoch':1,'grantId':'synthetic-grant'}
    def test_binding_drift_and_non_agent_activation_rejected_without_installing_grant(self):
        for field in ('providerId','environmentId','sessionId','instanceId','inputResourceId'):
            obj=self.bridge();authority=self.authority(obj);authority[field]='synthetic-replacement'
            with self.assertRaises(Blocked):obj.activate(authority)
            self.assertIsNone(obj.authority)
        obj=self.bridge();authority=self.authority(obj);authority['owner']['kind']='human'
        with self.assertRaises(Blocked):obj.activate(authority)
        self.assertIsNone(obj.authority)
    def test_full_authority_is_checked_and_action_checks_do_not_renew_lease(self):
        for key,value in [('epoch',2),('grantId','synthetic-other'),('owner',{'kind':'agent','clientId':'other'})]:
            obj=self.bridge();authority=self.authority(obj);obj.authority=authority
            request={**authority,key:value}
            with self.assertRaisesRegex(Blocked,'native_authority_revoked'):obj.check(request)
        obj=self.bridge();authority=self.authority(obj);obj.authority=authority
        before=obj.lease
        with patch.object(bridge_module,'write_json') as write:
            def read(path,default=None):
                if path.name=='state.json':return {'status':'ready','port':1,'heartbeat':time.monotonic()}
                return {'id':write.call_args.args[1]['id'],'ok':True}
            with patch.object(bridge_module,'read_json',side_effect=read):self.assertEqual(obj.check(authority),{'ready':True})
        self.assertEqual(obj.lease,before)
    def test_expired_native_lease_and_replaced_endpoint_fail_closed(self):
        obj=self.bridge();authority=self.authority(obj);obj.authority=authority;obj.lease=time.monotonic()-1
        with self.assertRaisesRegex(Blocked,'native_authority_revoked'):obj.ping(authority)
        obj=self.bridge();authority=self.authority(obj);obj.authority=authority
        with patch.object(bridge_module,'write_json'),patch.object(bridge_module,'read_json',return_value={'status':'ready','port':2,'heartbeat':time.monotonic()}):
            with self.assertRaisesRegex(Blocked,'native_binding_stale'):obj.check(authority)
    def test_inspect_is_readonly_without_grant_or_lease_renewal_and_rejects_drift(self):
        obj=self.bridge();before=obj.lease
        with patch.object(bridge_module,'write_json') as write,patch.object(bridge_module,'read_json',return_value={'status':'ready','port':1,'heartbeat':time.monotonic()}):
            self.assertEqual(obj.inspect(),{'ready':True});write.assert_not_called()
        self.assertIsNone(obj.authority);self.assertEqual(obj.lease,before)
        with patch.object(bridge_module,'read_json',return_value={'status':'ready','port':2,'heartbeat':time.monotonic()}):
            with self.assertRaisesRegex(Blocked,'native_binding_stale'):obj.inspect()

if __name__=='__main__':unittest.main()
