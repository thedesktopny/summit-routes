package com.summitsafety.chofer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DriverSetupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
