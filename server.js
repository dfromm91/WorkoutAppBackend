const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const app = express();
const db = new sqlite3.Database("./workoutApp.db");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

require("dotenv").config();

// Secret key for signing tokens
const JWT_SECRET = process.env.JWT_SECRET; // Replace with a secure value

// Function to generate JWT
const generateJWT = (userId) => {
  return jwt.sign(
    { id: user.id, isValidated: user.account_registered },
    JWT_SECRET,
    { expiresIn: "1h" } // Token expires in 1 hour
  );
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Token is required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user; // Attach the user info to the request
    next();
  });
};

app.use(express.json());
app.use(cors());

// Fetch all available exercises
app.get("/exercises", (req, res) => {
  const query = `SELECT id, name FROM ExerciseDefinitions`;
  db.all(query, (err, rows) => {
    if (err) return res.status(500).json({ error: "Internal server error" });
    res.json(rows);
  });
});

// Fetch a workout by userId and date
app.get("/workouts", authenticateToken, (req, res) => {
  const { userId, date } = req.query;

  if (!userId || !date) {
    return res.status(400).json({ error: "userId and date are required" });
  }

  const query = `
    SELECT 
      Workouts.id AS workoutId, 
      Workouts.date, 
      ExerciseInstances.id AS exerciseInstanceId, 
      ExerciseInstances.exercise_definition_id AS exerciseDefinitionId,
      ExerciseDefinitions.name AS exerciseName, 
      Sets.id AS setId, 
      Sets.weight, 
      Sets.repetitions
    FROM Workouts
    LEFT JOIN ExerciseInstances ON Workouts.id = ExerciseInstances.workout_id
    LEFT JOIN ExerciseDefinitions ON ExerciseInstances.exercise_definition_id = ExerciseDefinitions.id
    LEFT JOIN Sets ON ExerciseInstances.id = Sets.exercise_instance_id
    WHERE Workouts.user_id = ? AND Workouts.date = ?
  `;

  db.all(query, [userId, date], (err, rows) => {
    if (err) return res.status(500).json({ error: "Internal server error" });

    const workouts = rows.reduce((acc, row) => {
      let workout = acc.find((w) => w.id === row.workoutId);
      if (!workout) {
        workout = { id: row.workoutId, date: row.date, exercises: [] };
        acc.push(workout);
      }
      if (row.exerciseInstanceId) {
        let exercise = workout.exercises.find(
          (e) => e.id === row.exerciseInstanceId
        );
        if (!exercise) {
          exercise = {
            id: row.exerciseInstanceId,
            exercise_definition_id: row.exerciseDefinitionId,
            name: row.exerciseName || "Unknown Exercise",
            sets: [],
          };
          workout.exercises.push(exercise);
        }
        if (row.setId) {
          exercise.sets.push({
            id: row.setId,
            weight: row.weight,
            repetitions: row.repetitions,
          });
        }
      }
      return acc;
    }, []);

    res.json(workouts);
  });
});

// Create or update a workout
app.post("/workouts", authenticateToken, (req, res) => {
  const { user_id, date, exercises } = req.body;
  if (!user_id || !date || !Array.isArray(exercises)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const deleteWorkout = `DELETE FROM Workouts WHERE user_id = ? AND date = ?`;
  const insertWorkout = `INSERT INTO Workouts (user_id, date) VALUES (?, ?)`;
  const insertExercise = `
    INSERT INTO ExerciseInstances (workout_id, exercise_definition_id) 
    SELECT ?, id FROM ExerciseDefinitions WHERE id = ?
  `;
  const insertSet = `INSERT INTO Sets (exercise_instance_id, weight, repetitions) VALUES (?, ?, ?)`;

  db.serialize(() => {
    db.run(deleteWorkout, [user_id, date], (err) => {
      if (err)
        return res.status(500).json({ error: "Failed to delete workout" });

      db.run(insertWorkout, [user_id, date], function (err) {
        if (err)
          return res.status(500).json({ error: "Failed to insert workout" });

        const workoutId = this.lastID;

        exercises.forEach((exercise) => {
          db.run(
            insertExercise,
            [workoutId, exercise.exercise_definition_id],
            function (err) {
              if (err)
                return console.error("Error inserting exercise:", err.message);

              const exerciseInstanceId = this.lastID;

              exercise.sets.forEach((set) => {
                db.run(
                  insertSet,
                  [exerciseInstanceId, set.weight, set.repetitions],
                  (err) => {
                    if (err) console.error("Error inserting set:", err.message);
                  }
                );
              });
            }
          );
        });

        res.status(200).json({ message: "Workout saved successfully" });
      });
    });
  });
});

// Delete a workout
app.delete("/workouts/:id", authenticateToken, (req, res) => {
  const { id } = req.params;

  if (!id) return res.status(400).json({ error: "Workout ID is required" });

  const deleteSets = `DELETE FROM Sets WHERE exercise_instance_id IN (SELECT id FROM ExerciseInstances WHERE workout_id = ?)`;
  const deleteExerciseInstances = `DELETE FROM ExerciseInstances WHERE workout_id = ?`;
  const deleteWorkout = `DELETE FROM Workouts WHERE id = ?`;

  db.run(deleteSets, [id], (err) => {
    if (err) return res.status(500).json({ error: "Failed to delete sets" });

    db.run(deleteExerciseInstances, [id], (err) => {
      if (err)
        return res
          .status(500)
          .json({ error: "Failed to delete exercise instances" });

      db.run(deleteWorkout, [id], (err) => {
        if (err)
          return res.status(500).json({ error: "Failed to delete workout" });
        res.status(200).json({ message: "Workout deleted successfully" });
      });
    });
  });
});

app.get("/workouts/all", authenticateToken, (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const query = `
    SELECT 
      Workouts.id AS workoutId, 
      Workouts.date, 
      ExerciseInstances.id AS exerciseInstanceId, 
      ExerciseInstances.exercise_definition_id AS exerciseDefinitionId,
      ExerciseDefinitions.name AS exerciseName, 
      Sets.id AS setId, 
      Sets.weight, 
      Sets.repetitions
    FROM Workouts
    LEFT JOIN ExerciseInstances ON Workouts.id = ExerciseInstances.workout_id
    LEFT JOIN ExerciseDefinitions ON ExerciseInstances.exercise_definition_id = ExerciseDefinitions.id
    LEFT JOIN Sets ON ExerciseInstances.id = Sets.exercise_instance_id
    WHERE Workouts.user_id = ?
  `;

  db.all(query, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "Internal server error" });

    const workouts = rows.reduce((acc, row) => {
      let workout = acc.find((w) => w.id === row.workoutId);
      if (!workout) {
        workout = { id: row.workoutId, date: row.date, exercises: [] };
        acc.push(workout);
      }
      if (row.exerciseInstanceId) {
        let exercise = workout.exercises.find(
          (e) => e.id === row.exerciseInstanceId
        );
        if (!exercise) {
          exercise = {
            id: row.exerciseInstanceId,
            exercise_definition_id: row.exerciseDefinitionId,
            name: row.exerciseName || "Unknown Exercise",
            sets: [],
          };
          workout.exercises.push(exercise);
        }
        if (row.setId) {
          exercise.sets.push({
            id: row.setId,
            weight: row.weight,
            repetitions: row.repetitions,
          });
        }
      }
      return acc;
    }, []);
    console.log(workouts);
    res.json(workouts);
  });
});

// Register a new user with password encryption
const nodemailer = require("nodemailer");

app.post("/users/register", async (req, res) => {
  const { first_name, last_name, email, password } = req.body;

  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate a unique validation token
    const validationToken = crypto.randomBytes(32).toString("hex");

    const query = `
      INSERT INTO Users (first_name, last_name, email, password, confirmation_token, account_registered) 
      VALUES (?, ?, ?, ?, ?, 0)
    `;

    db.run(
      query,
      [first_name, last_name, email, hashedPassword, validationToken],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            return res
              .status(400)
              .json({ error: "Email is already registered" });
          }
          return res.status(500).json({ error: "Internal server error" });
        }

        // Prepare and send the validation email
        const transporter = nodemailer.createTransport({
          host: "smtp-relay.brevo.com",
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        const validationUrl = `http://localhost:3000/users/validate/${validationToken}`;
        const mailOptions = {
          from: process.env.EMAIL_SENDER,
          to: email,
          subject: "Account Validation - Workout Tracker",
          text: `Hi ${first_name},\n\nPlease validate your account by clicking the link below:\n${validationUrl}\n\nIf you did not register, you can safely ignore this email.`,
        };

        transporter.sendMail(mailOptions, (mailErr) => {
          if (mailErr) {
            console.error("Error sending validation email:", mailErr);
            return res.status(500).json({
              error: "User registered, but validation email failed to send",
            });
          }

          res.status(201).json({
            message:
              "User registered successfully. Please validate your email.",
          });
        });
      }
    );
  } catch (error) {
    console.error("Error hashing password or sending email:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/users/login", async (req, res) => {
  console.log("Login endpoint hit with data:", req.body);
  const { email, password } = req.body;

  // Validate input
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const query = "SELECT * FROM Users WHERE email = ?";
  db.get(query, [email], async (err, user) => {
    if (err) {
      console.error("Error querying user:", err.message);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (!user) {
      console.log("Login failed: User not found for email:", email);
      return res.status(404).json({ error: "User not found" });
    }

    try {
      // Check if the user has validated their email
      if (!user.account_registered) {
        console.log("Login failed: Email not validated for user:", email);
        return res
          .status(403)
          .json({ error: "Please validate your email before logging in" });
      }

      // Verify the password
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        console.log("Login failed: Incorrect password for email:", email);
        return res.status(401).json({ error: "Invalid credentials" });
      }

      console.log("Login successful for user:", user.email);

      // Generate a JWT token
      const token = jwt.sign(
        { id: user.id, isValidated: user.account_registered },
        JWT_SECRET,
        { expiresIn: "1h" } // Token expires in 1 hour
      );

      // Respond with token and user details
      res.json({
        token,
        user: { id: user.id, email: user.email, account_registered: true },
      });
    } catch (error) {
      console.error("Error during password comparison:", error.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

app.get("/users/validate/:token", (req, res) => {
  const { token } = req.params;

  if (!token) {
    return res.status(400).send("Invalid validation link.");
  }

  const query = "SELECT * FROM Users WHERE confirmation_token = ?";
  db.get(query, [token], (err, user) => {
    if (err) {
      console.error("Error querying database:", err.message);
      return res.status(500).send("Internal server error.");
    }

    if (!user) {
      return res.status(400).send("Invalid or expired validation token.");
    }

    const updateQuery =
      "UPDATE Users SET account_registered = 1, confirmation_token = NULL WHERE id = ?";
    db.run(updateQuery, [user.id], (updateErr) => {
      if (updateErr) {
        console.error(
          "Error updating user validation status:",
          updateErr.message
        );
        return res.status(500).send("Internal server error.");
      }

      res.send(
        "Your email has been successfully validated. You can now log in!"
      );
    });
  });
});

app.post("/users/logout", (req, res) => {
  try {
    // Perform any server-side cleanup if necessary
    console.log("User logged out");

    // Send a success response
    res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    console.error("Logout failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/users/validate-token", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1]; // Extract token

  if (!token) {
    return res.status(401).json({ error: "Token not provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ id: decoded.id, isValidated: decoded.isValidated });
  } catch (error) {
    console.error("Token validation failed:", error.message);
    res.status(401).json({ error: "Invalid token" });
  }
});

const PORT = 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
