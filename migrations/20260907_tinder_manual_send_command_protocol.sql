/*
  T5 signed command protocol vocabulary only.

  This explicit migration intentionally owns exactly one existing CHECK
  constraint extension.  It creates no tables, keys, indexes, rows or
  application-side dispatch capability.
*/
ALTER TABLE device_bridge_commands
  DROP CONSTRAINT device_bridge_commands_command_type_check_v2;

ALTER TABLE device_bridge_commands
  ADD CONSTRAINT device_bridge_commands_command_type_check_v3
  CHECK (command_type IN (
    'PING',
    'REQUEST_STATUS',
    'STOP_BRIDGE',
    'CONNECT_TINDER',
    'DISCONNECT_TINDER',
    'ARM_TINDER_CONVERSATION_BINDING',
    'SEND_TINDER_DRAFT'
  ));
