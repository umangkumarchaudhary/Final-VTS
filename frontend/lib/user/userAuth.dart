import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// Backend API URL
const String backendUrl = "http://192.168.58.49:5000/api"; // Change this

class UserAuth extends StatefulWidget {
  @override
  _UserAuthState createState() => _UserAuthState();
}

class _UserAuthState extends State<UserAuth> {
  bool isLogin = true; // Toggle between Login & Register
  final TextEditingController nameController = TextEditingController();
  final TextEditingController mobileController = TextEditingController();
  final TextEditingController emailController = TextEditingController();
  final TextEditingController passwordController = TextEditingController();
  String selectedRole = "Service Advisor"; // Default role

  final List<String> roles = [
    "Admin",
    "Workshop Manager",
    "Security Guard",
    "Active Reception Technician",
    "Service Advisor",
    "Job Controller",
    "Bay Technician",
    "Final Inspection Technician",
    "Diagnosis Engineer",
    "Washing",
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(isLogin ? "Login" : "Register")),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (!isLogin)
              TextField(
                controller: nameController,
                decoration: InputDecoration(labelText: "Name"),
              ),
            TextField(
              controller: mobileController,
              decoration: InputDecoration(labelText: "Mobile"),
              keyboardType: TextInputType.phone,
            ),
            if (!isLogin)
              TextField(
                controller: emailController,
                decoration: InputDecoration(labelText: "Email (Optional)"),
                keyboardType: TextInputType.emailAddress,
              ),
            TextField(
              controller: passwordController,
              decoration: InputDecoration(labelText: "Password"),
              obscureText: true,
            ),
            if (!isLogin)
              DropdownButtonFormField(
                value: selectedRole,
                items: roles.map((role) {
                  return DropdownMenuItem(
                    value: role,
                    child: Text(role),
                  );
                }).toList(),
                onChanged: (value) {
                  setState(() {
                    selectedRole = value.toString();
                  });
                },
                decoration: InputDecoration(labelText: "Select Role"),
              ),
            SizedBox(height: 20),
            ElevatedButton(
              onPressed: () => isLogin ? login() : register(),
              child: Text(isLogin ? "Login" : "Register"),
            ),
            TextButton(
              onPressed: () {
                setState(() {
                  isLogin = !isLogin;
                });
              },
              child: Text(isLogin
                  ? "Don't have an account? Register"
                  : "Already have an account? Login"),
            ),
          ],
        ),
      ),
    );
  }

  // 📌 Register User
  Future<void> register() async {
    final response = await http.post(
      Uri.parse('$backendUrl/register'),
      headers: {"Content-Type": "application/json"},
      body: jsonEncode({
        "name": nameController.text.trim(),
        "mobile": mobileController.text.trim(),
        "email": emailController.text.trim(),
        "password": passwordController.text.trim(),
        "role": selectedRole
      }),
    );

    final data = jsonDecode(response.body);

    if (response.statusCode == 201) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(data["message"])));
      setState(() {
        isLogin = true; // Switch to login after successful registration
      });
    } else {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(data["message"])));
    }
  }

  // 📌 Login User
  Future<void> login() async {
    final response = await http.post(
      Uri.parse('$backendUrl/login'),
      headers: {"Content-Type": "application/json"},
      body: jsonEncode({
        "mobile": mobileController.text.trim(),
        "password": passwordController.text.trim()
      }),
    );

    final data = jsonDecode(response.body);

    if (response.statusCode == 200) {
      SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString("token", data["token"]);
      await prefs.setString("userRole", data["user"]["role"]);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("Login Successful!")));
    } else {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(data["message"])));
    }
  }
}
