#!/bin/bash

bitcoincli=$(command -v bitcoin-cli)
opts=( -rpcuser="testuser" -rpcpassword="lq6zequb-gYTdF2_ZEUtr8ywTXzLYtknzWU4nV8uVoo=" -regtest )

newaddress=$($bitcoincli "${opts[@]}" -rpcwallet=alice getnewaddress bec32)
$bitcoincli "${opts[@]}" generatetoaddress 10 ${newaddress} &> /dev/null
